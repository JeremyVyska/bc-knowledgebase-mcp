/**
 * analyze_al_code Tool - Handler Implementation
 *
 * AL code analysis and workspace inspection handlers
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively find all .al files in a directory
 */
function findAlFiles(dir: string, files: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common non-source directories
        if (!['node_modules', '.git', '.vscode', 'bin', 'obj', '.alpackages'].includes(entry.name)) {
          findAlFiles(fullPath, files);
        }
      } else if (entry.isFile() && entry.name.endsWith('.al')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dir}:`, error);
  }
  return files;
}

/**
 * Read file content safely
 */
function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return null;
  }
}

export function createAnalyzeAlCodeHandler(services: any) {
  const { codeAnalysisService, methodologyService } = services;

  return async (args: any) => {
    const {
      code,
      file_path,
      file_paths,
      workspace_path,
      analysis_type = 'comprehensive',
      operation = 'analyze',
      bc_version,
      suggest_workflows = true
    } = args;

    // Determine what to analyze
    let filesToAnalyze: Array<{ path: string; content: string }> = [];
    let rawCode: string | null = null;

    // Priority: workspace_path > file_paths > file_path > code
    if (workspace_path) {
      // Scan workspace for .al files
      const alFiles = findAlFiles(workspace_path);
      console.error(`📁 Found ${alFiles.length} .al files in workspace: ${workspace_path}`);

      for (const filePath of alFiles) {
        const content = readFileContent(filePath);
        if (content) {
          filesToAnalyze.push({ path: filePath, content });
        }
      }

      if (filesToAnalyze.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No .al files found in workspace',
              workspace_path,
              suggestion: 'Ensure the workspace_path points to a directory containing .al files'
            }, null, 2)
          }]
        };
      }
    } else if (file_paths && Array.isArray(file_paths)) {
      // Analyze specific files
      for (const filePath of file_paths) {
        const content = readFileContent(filePath);
        if (content) {
          filesToAnalyze.push({ path: filePath, content });
        }
      }
    } else if (file_path) {
      // Analyze single file
      const content = readFileContent(file_path);
      if (content) {
        filesToAnalyze.push({ path: file_path, content });
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Could not read file: ${file_path}`,
              suggestion: 'Ensure the file path is correct and the file exists'
            }, null, 2)
          }]
        };
      }
    } else if (code) {
      // Use raw code (legacy support)
      rawCode = code;
    } else {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'No input provided',
            suggestion: 'Provide one of: workspace_path, file_paths, file_path, or code',
            examples: {
              workspace_path: 'C:/Projects/MyBCApp',
              file_path: 'C:/Projects/MyBCApp/src/Codeunit.al',
              file_paths: ['file1.al', 'file2.al']
            }
          }, null, 2)
        }]
      };
    }

    // Handle multi-file analysis
    if (filesToAnalyze.length > 0) {
      const allResults: any[] = [];
      const aggregatedIssues: any[] = [];
      const aggregatedPatterns: Set<string> = new Set();
      const aggregatedOpportunities: any[] = [];
      const aggregatedTopics: Map<string, any> = new Map();

      for (const file of filesToAnalyze) {
        const analysisResult = await codeAnalysisService.analyzeCode({
          code_snippet: file.content,
          analysis_type,
          suggest_topics: suggest_workflows,
          bc_version
        });

        // Add file path to each issue for context
        const issuesWithPath = (analysisResult.issues || []).map((issue: any) => ({
          ...issue,
          file: file.path
        }));
        aggregatedIssues.push(...issuesWithPath);

        // Collect patterns
        (analysisResult.patterns_detected || []).forEach((p: string) => aggregatedPatterns.add(p));

        // Collect opportunities with file context
        const opportunitiesWithPath = (analysisResult.optimization_opportunities || []).map((opp: any) => ({
          ...opp,
          file: file.path
        }));
        aggregatedOpportunities.push(...opportunitiesWithPath);

        // Dedupe topics by ID
        (analysisResult.suggested_topics || []).forEach((topic: any) => {
          if (!aggregatedTopics.has(topic.id)) {
            aggregatedTopics.set(topic.id, topic);
          }
        });

        allResults.push({
          file: file.path,
          issues_count: issuesWithPath.length,
          patterns_count: analysisResult.patterns_detected?.length || 0
        });
      }

      // Get relevance matches from the analysis service (V2)
      const relevanceMatches = codeAnalysisService.getLastRelevanceMatches?.() || [];

      // Build summary response
      const summary = {
        files_analyzed: filesToAnalyze.length,
        file_results: allResults,
        total_issues: aggregatedIssues.length,
        issues_by_severity: {
          critical: aggregatedIssues.filter((i: any) => i.severity === 'critical').length,
          high: aggregatedIssues.filter((i: any) => i.severity === 'high').length,
          medium: aggregatedIssues.filter((i: any) => i.severity === 'medium').length,
          low: aggregatedIssues.filter((i: any) => i.severity === 'low').length
        },
        patterns_detected: Array.from(aggregatedPatterns),
        issues: aggregatedIssues.slice(0, 50), // Limit to 50 issues to avoid huge responses
        optimization_opportunities: aggregatedOpportunities.slice(0, 20),
        suggested_topics: Array.from(aggregatedTopics.values()).slice(0, 10),

        // V2: Relevance-based knowledge matches
        relevant_knowledge: relevanceMatches.slice(0, 10).map((match: any) => ({
          topic_id: match.topicId,
          title: match.title,
          relevance_score: match.relevanceScore,
          domain: match.domain,
          category: match.category,
          matched_signals: match.matchedSignals || [],
          recommendation: match.severity === 'high' || match.severity === 'critical'
            ? 'Review recommended'
            : 'Consider reviewing'
        })),

        workflow_integration: {
          instruction: 'If running within a workflow session, pass suggested_topics to workflow_progress(expand_checklist=...) to add them to the current file\'s checklist.',
          expand_checklist_payload: Array.from(aggregatedTopics.values()).slice(0, 10).map((topic: any) => ({
            topic_id: topic.id,
            relevance_score: topic.relevance_score || 0.8,
            description: topic.title || topic.description
          }))
        }
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2)
        }]
      };
    }

    // Handle legacy "workspace" keyword - redirect to use workspace_path instead
    if (rawCode && rawCode.toLowerCase() === 'workspace') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'The "workspace" keyword is deprecated',
            suggestion: 'Use workspace_path parameter instead to scan a directory for .al files',
            example: {
              workspace_path: 'C:/Projects/MyBCApp',
              analysis_type: 'comprehensive',
              bc_version: 'BC22'
            },
            note: 'The MCP will read all .al files and analyze them, saving tokens compared to passing code content.'
          }, null, 2)
        }]
      };
    }

    // Raw code snippet analysis (legacy support)
    if (rawCode) {
      // Code snippet analysis
      const analysisResult = await codeAnalysisService.analyzeCode({
        code_snippet: rawCode,
        analysis_type,
        suggest_topics: suggest_workflows,
        bc_version
      });

      // VALIDATE OPERATION: Return compliance issues + auto-fix suggestions
      if (operation === 'validate') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              response_type: 'validation_report',
              compliance_issues: analysisResult.issues || [],
              auto_fix_suggestions: analysisResult.patterns
                ?.filter((p: any) => p.auto_fixable === true)
                .map((p: any) => ({
                  issue: p.pattern,
                  fix_action: p.recommended_action,
                  code_snippet: p.code_snippet,
                  confidence: p.confidence || 0.9
                })) || [],
              blocking_issues: analysisResult.issues?.filter((i: any) => i.severity === 'critical') || [],
              warnings: analysisResult.issues?.filter((i: any) => i.severity === 'warning') || [],
              bc_version: bc_version,
              analysis_type: analysis_type
            }, null, 2)
          }]
        };
      }

      // SUGGEST_FIXES OPERATION: Return code transformations
      if (operation === 'suggest_fixes') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              response_type: 'code_transformations',
              transformations: analysisResult.patterns
                ?.map((p: any) => ({
                  pattern: p.pattern,
                  transformation: p.recommended_action,
                  before_code: p.code_snippet,
                  after_code: p.suggested_code || '// Auto-generation not available',
                  impact: p.impact || 'medium',
                  confidence: p.confidence || 0.85
                })) || [],
              recommended_workflow: suggest_workflows ? await methodologyService.findWorkflowsByQuery('code optimization') : null,
              bc_version: bc_version
            }, null, 2)
          }]
        };
      }

      // ANALYZE OPERATION: Return conversational analysis
      // Add workflow_integration for v2 workflows
      const result = {
        ...analysisResult,
        workflow_integration: {
          instruction: 'If running within a workflow session, pass suggested_topics to workflow_progress(expand_checklist=...) to add them to the current file\'s checklist.',
          expand_checklist_payload: analysisResult.suggested_topics?.map((topic: any) => ({
            topic_id: topic.topic_id || topic.id || topic,
            relevance_score: topic.relevance_score || topic.relevance || 0.8,
            description: topic.description || topic.title || topic
          })) || []
        }
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }

    // Fallback - should not reach here due to validation above
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'No valid input provided',
          suggestion: 'Provide workspace_path, file_path, file_paths, or code parameter'
        }, null, 2)
      }]
    };
  };
}
