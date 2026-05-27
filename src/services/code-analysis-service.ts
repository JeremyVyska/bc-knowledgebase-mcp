import {
  CodeAnalysisParams,
  CodeAnalysisResult,
  TopicSearchResult,
  ALCodePattern,
  AtomicTopic,
  getDomainList,
} from "../types/bc-knowledge.js";
import { KnowledgeService } from "./knowledge-service.js";
import {
  RelevanceIndexService,
  RelevanceMatch,
} from "./relevance-index-service.js";

/**
 * AL Code Analysis Service
 *
 * Analyzes AL code for performance issues, anti-patterns, and optimization
 * opportunities. Dynamically loads patterns from the layered knowledge system.
 *
 * ## Suggestion Loading Strategy
 *
 * This service now supports dynamic loading of code analysis suggestions from
 * the layered knowledge system:
 *
 * 1. **Dynamic Loading (Primary)**: Loads suggestions from layer topics
 *    - Topic path pattern: `code-analysis/suggestions/{pattern-name}`
 *    - Example: `code-analysis/suggestions/manual-summation-instead-of-sift`
 *    - Supports layer overrides (project > team > company > embedded)
 *    - Cached for 5 minutes to avoid repeated queries
 *
 * 2. **Fallback (Secondary)**: Uses hardcoded suggestions if topic not found
 *    - Maintains backward compatibility
 *    - Prevents runtime crashes when topics are missing
 *    - TODO: Migrate these to embedded-knowledge topics
 *
 * ## Topic Structure for Suggestions
 *
 * Each suggestion topic should be a markdown file in:
 * `embedded-knowledge/topics/code-analysis/suggestions/{pattern-name}.md`
 *
 * Example topic structure:
 * ```markdown
 * ---
 * title: Manual Summation Instead of SIFT
 * domain: performance
 * difficulty: intermediate
 * tags: [performance, sift, optimization]
 * ---
 *
 * Replace manual summation loops with SIFT CalcSums method for better performance.
 * Example: Record.CalcSums(Amount) instead of looping through records.
 *
 * ## Why This Matters
 * Manual summation can be 10-100x slower than SIFT indexes...
 * ```
 *
 * The first paragraph becomes the inline suggestion text.
 *
 * ## Migration Path
 *
 * To migrate hardcoded suggestions to topics:
 * 1. Create markdown file in embedded-knowledge/topics/code-analysis/suggestions/
 * 2. Use the pattern name as the filename (e.g., `manual-summation-instead-of-sift.md`)
 * 3. Add frontmatter with metadata
 * 4. Write suggestion text as first paragraph
 * 5. Test that the service loads the topic correctly
 * 6. Remove from fallback dictionary once confirmed working
 */
export class CodeAnalysisService {
  private patternCache: ALCodePattern[] | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Cache for dynamically loaded suggestions from layer topics
  private suggestionsCache: Map<string, string> | null = null;
  private suggestionsCacheExpiry: number = 0;

  // V2: Relevance-based detection
  private relevanceIndexService: RelevanceIndexService | null = null;
  private useRelevanceBasedDetection: boolean = true;

  // Store last relevance matches for handler enrichment
  private lastRelevanceMatches: RelevanceMatch[] = [];

  constructor(
    private knowledgeService: KnowledgeService,
    relevanceIndexService?: RelevanceIndexService, // Optional for backward compatibility
  ) {
    this.relevanceIndexService = relevanceIndexService || null;
    this.useRelevanceBasedDetection = !!relevanceIndexService;
  }

  /**
   * Enable or disable relevance-based detection
   * When disabled, falls back to legacy regex patterns
   */
  setUseRelevanceBasedDetection(enabled: boolean): void {
    this.useRelevanceBasedDetection = enabled && !!this.relevanceIndexService;
  }

  /**
   * Get the last relevance matches from the most recent analysis
   * Used by handlers to enrich output with relevance metadata
   */
  getLastRelevanceMatches(): RelevanceMatch[] {
    return this.lastRelevanceMatches;
  }

  /**
   * Load AL code patterns dynamically from knowledge base
   */
  private async loadPatterns(): Promise<ALCodePattern[]> {
    // Check cache first
    if (this.patternCache && Date.now() < this.cacheExpiry) {
      console.error(
        `🔍 Using cached patterns: ${this.patternCache.length} patterns`,
      );
      return this.patternCache;
    }

    try {
      // Get all code-pattern topics from the knowledge base
      const patternTopics =
        await this.knowledgeService.findTopicsByType("code-pattern");
      console.error(
        `🔍 Found ${patternTopics.length} code-pattern topics in knowledge base`,
      );

      const patterns: ALCodePattern[] = patternTopics.map((topic) => {
        const frontmatter = topic.frontmatter || {};

        return {
          name: frontmatter.name || topic.id,
          pattern_type: frontmatter.pattern_type || "unknown",
          regex_patterns: this.parseRegexPatterns(frontmatter.regex_patterns),
          description: frontmatter.description || topic.title,
          related_topics: frontmatter.related_topics || [],
          severity: frontmatter.severity,
          category: frontmatter.category,
          impact_level: frontmatter.impact_level,
          detection_confidence: frontmatter.detection_confidence,
        };
      });

      // Load organization standards/guidelines from company + project layers
      const orgStandards = await this.loadOrganizationStandards();

      // If no patterns from knowledge base, use fallback patterns
      // This ensures we always have analysis capabilities
      const basePatterns =
        patterns.length > 0 ? patterns : this.getFallbackPatterns();
      console.error(
        `🔍 Using ${basePatterns.length} base patterns (${patterns.length > 0 ? "from knowledge base" : "fallback"})`,
      );

      // Update cache with both pattern-based and standards-based rules
      this.patternCache = [...basePatterns, ...orgStandards];
      this.cacheExpiry = Date.now() + this.CACHE_TTL;

      console.error(
        `🔍 Total patterns loaded: ${this.patternCache.length} (${basePatterns.length} base + ${orgStandards.length} org standards)`,
      );

      return this.patternCache;
    } catch (error) {
      console.warn("Failed to load code patterns from knowledge base:", error);
      return this.getFallbackPatterns();
    }
  }

  /**
   * Load organization standards and guidelines from knowledge layers
   * Searches company AND project layers - project layer overrides company layer
   * These are policy-based rules that may not have regex patterns
   */
  private async loadOrganizationStandards(): Promise<ALCodePattern[]> {
    try {
      // Search for company/project standards, coding guidelines, naming conventions
      const standardsTopics = await this.knowledgeService.searchTopics({
        code_context:
          "company standards coding guidelines naming conventions best practices policy rules",
        limit: 50,
      });

      const standards: ALCodePattern[] = [];

      for (const topicResult of standardsTopics) {
        const topic = await this.knowledgeService.getTopic(topicResult.id);
        if (!topic) continue;

        // Extract guidelines from content
        const guidelines = this.extractGuidelinesFromContent(topic);
        standards.push(...guidelines);
      }

      console.error(
        `📋 Loaded ${standards.length} organization standards from knowledge layers (company + project)`,
      );
      return standards;
    } catch (error) {
      console.warn("Failed to load organization standards:", error);
      return [];
    }
  }

  /**
   * Extract actionable guidelines from topic content
   * Looks for patterns like "must", "should", "required", "mandatory"
   */
  private extractGuidelinesFromContent(topic: AtomicTopic): ALCodePattern[] {
    const guidelines: ALCodePattern[] = [];
    const content = topic.content;

    // Look for common guideline patterns
    const guidelinePatterns = [
      /(?:must|required|mandatory):\s*(.+?)(?:\n|$)/gi,
      /(?:should|recommended):\s*(.+?)(?:\n|$)/gi,
      /(?:do not|don't|avoid):\s*(.+?)(?:\n|$)/gi,
      /(?:always|never):\s*(.+?)(?:\n|$)/gi,
    ];

    guidelinePatterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const guideline = match[1].trim();
        if (guideline.length > 10 && guideline.length < 200) {
          guidelines.push({
            name: `company-standard-${topic.id}`,
            pattern_type: "unknown", // Will be evaluated based on code context
            regex_patterns: [], // No regex for policy-based rules
            description: `${topic.title}: ${guideline}`,
            related_topics: [topic.id],
            severity:
              match[0].toLowerCase().includes("must") ||
              match[0].toLowerCase().includes("required")
                ? "high"
                : "medium",
            category: "company-standard",
          });
        }
      }
    });

    return guidelines;
  }

  /**
   * Parse regex patterns from YAML (can be strings or array)
   */
  private parseRegexPatterns(patterns: any): RegExp[] {
    if (!patterns) return [];

    const patternArray = Array.isArray(patterns) ? patterns : [patterns];
    return patternArray.map((pattern) => {
      try {
        return new RegExp(pattern, "gis");
      } catch (error) {
        console.warn(`Invalid regex pattern: ${pattern}`);
        return new RegExp("(?!)", "g"); // Never-matching regex
      }
    });
  }

  /**
   * Fallback patterns if knowledge base is unavailable
   */
  private getFallbackPatterns(): ALCodePattern[] {
    return [
      // Performance Anti-Patterns
      {
        name: "manual-summation-instead-of-sift",
        pattern_type: "bad",
        regex_patterns: [
          /repeat\s+[\s\S]*?\+=[\s\S]*?until.*\.Next\(\)/gis,
          /while.*\.Next\(\)\s*=\s*0[\s\S]*?\+=/gis,
        ],
        description:
          "Manual record summation detected - consider using SIFT CalcSums for better performance",
        related_topics: [
          "sift-technology-fundamentals",
          "query-performance-patterns",
          "flowfield-optimization",
        ],
      },
      {
        name: "missing-setloadfields",
        pattern_type: "bad",
        regex_patterns: [
          /FindSet\(\)[\s\S]*?repeat[\s\S]*?(\w+\."[^"]*"\s*[,;].*){3,}/gis,
        ],
        description:
          "Multiple field access without SetLoadFields - this loads unnecessary data",
        related_topics: [
          "setloadfields-optimization",
          "memory-optimization",
          "performance-patterns",
        ],
      },
      {
        name: "individual-calcfields-calls",
        pattern_type: "bad",
        regex_patterns: [/CalcFields\([^)]*\)[\s\S]*?CalcFields\([^)]*\)/gis],
        description:
          "Multiple individual CalcFields calls - consider batching for better performance",
        related_topics: [
          "flowfield-optimization",
          "batch-processing-optimization",
        ],
      },
      {
        name: "inefficient-deleteall",
        pattern_type: "bad",
        regex_patterns: [
          /repeat[\s\S]*?Delete\((?:true)?\);[\s\S]*?until.*\.Next\(\)/gis,
        ],
        description:
          "Individual record deletion in loop - consider using DeleteAll for better performance",
        related_topics: [
          "deleteall-patterns",
          "batch-processing-optimization",
          "performance-optimization",
        ],
      },

      // Performance Good Patterns
      {
        name: "sift-calcsum-usage",
        pattern_type: "good",
        regex_patterns: [
          /CalcSums\s*\(/gi,
          /SumIndexFields.*=.*MaintainSIFTIndex.*=.*true/gis,
        ],
        description: "Good use of SIFT CalcSums for aggregation",
        related_topics: [
          "sift-technology-fundamentals",
          "performance-monitoring",
        ],
      },
      {
        name: "setloadfields-optimization",
        pattern_type: "good",
        regex_patterns: [/SetLoadFields\s*\([^)]+\)[\s\S]*?FindSet\s*\(/gis],
        description: "Excellent use of SetLoadFields for memory optimization",
        related_topics: ["memory-optimization", "performance-best-practices"],
      },
      {
        name: "proper-key-usage",
        pattern_type: "good",
        regex_patterns: [
          /SetCurrentKey\s*\([^)]+\)[\s\S]*?SetRange\s*\([^)]+\)/gis,
        ],
        description: "Good practice: setting appropriate key before filtering",
        related_topics: ["index-optimization", "query-performance-patterns"],
      },

      // Validation Patterns
      {
        name: "testfield-validation",
        pattern_type: "good",
        regex_patterns: [/TestField\s*\(/gi],
        description: "Good use of TestField for validation",
        related_topics: [
          "testfield-patterns",
          "validation-strategies",
          "error-handling",
        ],
      },
      {
        name: "fielderror-usage",
        pattern_type: "unknown",
        regex_patterns: [/FieldError\s*\(/gi],
        description:
          "FieldError usage detected - ensure proper error message construction",
        related_topics: [
          "fielderror-patterns",
          "error-message-construction",
          "user-experience",
        ],
      },
      {
        name: "missing-validation",
        pattern_type: "bad",
        regex_patterns: [
          /Insert\s*\(\s*(?:true)?\s*\);[\s\S]*?(?!TestField|FieldError|if.*=.*'')/gis,
        ],
        description:
          "Record insertion without visible validation - consider adding validation",
        related_topics: [
          "validation-patterns",
          "data-integrity",
          "business-rules",
        ],
      },

      // Security Patterns
      {
        name: "missing-permission-check",
        pattern_type: "bad",
        regex_patterns: [
          /User\.Get\s*\([^)]+\)[^;]*?(?!UserPermissions\.Get|Permission\.)/gis,
          /Database\.SelectLatestVersion\s*\([^)]+\)(?![\s\S]*?Permission)/gis,
        ],
        description: "User or database access without permission validation",
        related_topics: [
          "user-permissions",
          "security-fundamentals",
          "access-control",
        ],
      },
      {
        name: "hardcoded-credentials",
        pattern_type: "bad",
        regex_patterns: [
          /password\s*:=\s*'[^']+'/gi,
          /token\s*:=\s*'[A-Za-z0-9]{20,}'/gi,
          /(apikey|secret|pwd)\s*:=\s*'[^']+'/gi,
        ],
        description:
          "Hardcoded credentials detected - use secure configuration",
        related_topics: [
          "credential-management",
          "security-configuration",
          "secrets-handling",
        ],
      },
      {
        name: "sql-injection-risk",
        pattern_type: "bad",
        regex_patterns: [
          /Database\.Execute\s*\([^)]*\+[^)]*\)/gis,
          /SELECTSQL\s*\([^)]*\+[^)]*\)/gis,
        ],
        description: "SQL concatenation detected - potential injection risk",
        related_topics: [
          "sql-injection-prevention",
          "parameterized-queries",
          "data-safety",
        ],
      },
      {
        name: "secure-communication",
        pattern_type: "good",
        regex_patterns: [
          /HttpClient\..*https:\/\//gi,
          /WebServiceConnection.*SSL.*=.*true/gis,
        ],
        description: "Good practice: using secure HTTPS communication",
        related_topics: [
          "secure-communications",
          "api-security",
          "encryption-patterns",
        ],
      },

      // Enhanced Validation Patterns
      {
        name: "weak-field-validation",
        pattern_type: "bad",
        regex_patterns: [
          /if\s+.*\."[^"]*"\s*=\s*''\s+then/gis,
          /if\s+.*\."[^"]*"\s*<>\s*''\s+then[\s\S]*?else[\s\S]*?Error/gis,
        ],
        description:
          "Weak field validation - consider using TestField for better UX",
        related_topics: [
          "validation-patterns",
          "testfield-patterns",
          "user-experience",
        ],
      },
      {
        name: "missing-range-validation",
        pattern_type: "bad",
        regex_patterns: [
          /(?:Quantity|Amount|Price|Rate)\s*:=\s*[^;]*;(?![\s\S]*?if.*>.*0)/gis,
        ],
        description: "Numeric field assignment without range validation",
        related_topics: [
          "numeric-validation",
          "business-rules",
          "data-integrity",
        ],
      },
      {
        name: "comprehensive-validation",
        pattern_type: "good",
        regex_patterns: [
          /TestField\s*\([^)]+\);[\s\S]*?if.*in.*\[.*\].*then/gis,
          /ValidateFields\s*\(/gi,
        ],
        description: "Comprehensive validation with TestField and range checks",
        related_topics: [
          "validation-best-practices",
          "data-integrity",
          "business-rules",
        ],
      },

      // Error Handling Patterns
      {
        name: "silent-error-handling",
        pattern_type: "bad",
        regex_patterns: [
          /begin[\s\S]*?end;[\s\S]*?if.*GetLastError.*<>.*''.*then/gis,
          /ClearLastError\s*\(\s*\);/gi,
        ],
        description:
          "Silent error handling - consider proper error propagation",
        related_topics: [
          "error-handling-patterns",
          "error-propagation",
          "debugging-strategies",
        ],
      },
      {
        name: "missing-transaction-handling",
        pattern_type: "bad",
        regex_patterns: [
          /(Insert|Modify|Delete)\s*\([^)]*\);[\s\S]*?(Insert|Modify|Delete)\s*\([^)]*\);(?![\s\S]*?Commit)/gis,
        ],
        description: "Multiple data operations without transaction handling",
        related_topics: [
          "transaction-patterns",
          "data-consistency",
          "error-recovery",
        ],
      },
      {
        name: "proper-error-handling",
        pattern_type: "good",
        regex_patterns: [
          /if.*not.*Codeunit\.Run\s*\([^)]+\).*then[\s\S]*?Error\s*\(/gis,
          /try[\s\S]*?catch[\s\S]*?Error\s*\(/gis,
        ],
        description: "Good practice: proper error handling with user feedback",
        related_topics: [
          "error-handling-best-practices",
          "user-experience",
          "debugging-strategies",
        ],
      },

      // Data Safety Patterns
      {
        name: "unsafe-bulk-operations",
        pattern_type: "bad",
        regex_patterns: [
          /DeleteAll\s*\(\s*\);(?![\s\S]*?SetRange)/gis,
          /ModifyAll\s*\([^)]*\)(?![\s\S]*?SetRange)/gis,
        ],
        description:
          "Bulk operations without filters - potential data loss risk",
        related_topics: [
          "data-safety-patterns",
          "bulk-operations",
          "data-protection",
        ],
      },
      {
        name: "missing-backup-validation",
        pattern_type: "bad",
        regex_patterns: [
          /Delete\s*\((?:true)?\);(?![\s\S]*?Confirm\s*\(|[\s\S]*?if.*Count.*>)/gis,
        ],
        description: "Record deletion without user confirmation or validation",
        related_topics: [
          "data-protection",
          "user-confirmation",
          "deletion-patterns",
        ],
      },
      {
        name: "safe-data-operations",
        pattern_type: "good",
        regex_patterns: [
          /if.*Confirm\s*\([^)]*\).*then[\s\S]*?Delete/gis,
          /SetRange\s*\([^)]+\);[\s\S]*?if.*FindSet.*then[\s\S]*?DeleteAll/gis,
        ],
        description: "Safe data operations with confirmation and filtering",
        related_topics: [
          "data-safety-best-practices",
          "user-confirmation",
          "filtering-patterns",
        ],
      },

      // Code Quality Patterns
      {
        name: "excessive-nesting",
        pattern_type: "bad",
        regex_patterns: [/if[\s\S]*?if[\s\S]*?if[\s\S]*?if[\s\S]*?begin/gis],
        description:
          "Excessive nesting detected - consider refactoring for readability",
        related_topics: [
          "code-complexity",
          "refactoring-patterns",
          "maintainability",
        ],
      },
      {
        name: "magic-numbers",
        pattern_type: "bad",
        regex_patterns: [
          /(?<!Date\s*\()\b(?:365|30|12|24|60)\b(?!\s*[)])/g,
          /\b\d{4,}\b(?![\s]*[)])/g,
        ],
        description: "Magic numbers detected - consider using named constants",
        related_topics: [
          "code-readability",
          "constants-usage",
          "maintainability",
        ],
      },
      {
        name: "good-code-structure",
        pattern_type: "good",
        regex_patterns: [
          /const[\s\S]*?=.*\d+;/gi,
          /local\s+procedure\s+\w+[A-Za-z]+\s*\(/gi,
        ],
        description:
          "Good practice: using constants and well-named local procedures",
        related_topics: [
          "code-organization",
          "naming-conventions",
          "maintainability",
        ],
      },

      // Architecture Patterns
      {
        name: "tight-coupling",
        pattern_type: "bad",
        regex_patterns: [/Codeunit\s*::\s*"[^"]*"\s*\.[A-Za-z]+/gis],
        description:
          "Tight coupling between objects - consider using interfaces",
        related_topics: [
          "loose-coupling",
          "interface-patterns",
          "dependency-injection",
        ],
      },
      {
        name: "event-subscriber-usage",
        pattern_type: "good",
        regex_patterns: [
          /\[EventSubscriber\s*\(/gi,
          /\[IntegrationEvent\s*\(/gi,
        ],
        description: "Good practice: using event-driven architecture",
        related_topics: [
          "event-architecture",
          "subscriber-patterns",
          "extension-development",
        ],
      },
      {
        name: "proper-separation-of-concerns",
        pattern_type: "good",
        regex_patterns: [/interface\s+"[^"]*"/gi, /implements\s+"[^"]*"/gi],
        description:
          "Good architecture: using interfaces for separation of concerns",
        related_topics: [
          "interface-design",
          "clean-architecture",
          "dependency-management",
        ],
      },
      {
        name: "temporary-table-safety",
        pattern_type: "good",
        regex_patterns: [/IsTemporary[\s\S]*?(?:Insert|Modify|Delete)/gis],
        description:
          "Good practice: checking IsTemporary before table operations",
        related_topics: [
          "temporary-table-patterns",
          "data-protection",
          "defensive-programming",
        ],
      },

      // User Experience Patterns
      {
        name: "poor-error-messages",
        pattern_type: "bad",
        regex_patterns: [
          /Error\s*\(\s*'[^']{1,20}'\s*\)/gi,
          /FieldError\s*\([^,]*,\s*'[^']{1,15}'\s*\)/gis,
        ],
        description:
          "Generic or unclear error messages - improve user experience",
        related_topics: [
          "error-message-design",
          "user-experience",
          "localization-patterns",
        ],
      },
      {
        name: "missing-progress-indication",
        pattern_type: "bad",
        regex_patterns: [
          /repeat[\s\S]*?until.*\.Next\(\).*=.*0(?![\s\S]*?Dialog\.Update|Window\.Update)/gis,
        ],
        description: "Long-running process without progress indication",
        related_topics: [
          "progress-indicators",
          "user-experience",
          "background-processing",
        ],
      },
      {
        name: "good-user-feedback",
        pattern_type: "good",
        regex_patterns: [
          /Dialog\.Open\s*\([^)]*\);[\s\S]*?Dialog\.Update/gis,
          /Message\s*\([^)]*StrSubstNo\s*\(/gis,
        ],
        description:
          "Good UX: providing progress feedback and formatted messages",
        related_topics: [
          "user-feedback-patterns",
          "progress-indication",
          "message-formatting",
        ],
      },

      // API Design Patterns
      {
        name: "inconsistent-api-design",
        pattern_type: "bad",
        regex_patterns: [
          /procedure\s+Get\w*\s*\([^)]*\)\s*:\s*Boolean[\s\S]*?procedure\s+Find\w*\s*\([^)]*\)\s*:\s*Record/gis,
        ],
        description:
          "Inconsistent API patterns - standardize Get/Find naming conventions",
        related_topics: [
          "api-design-consistency",
          "naming-conventions",
          "interface-design",
        ],
      },
      {
        name: "good-api-design",
        pattern_type: "good",
        regex_patterns: [
          /procedure\s+\w+\s*\([^)]*var\s+\w+\s*:\s*Record[^)]*\)\s*:\s*Boolean/gis,
        ],
        description:
          "Good API design: consistent parameter patterns and return types",
        related_topics: [
          "api-design-best-practices",
          "parameter-patterns",
          "return-type-consistency",
        ],
      },
    ];
  }

  /**
   * Analyze AL code for patterns, issues, and optimization opportunities
   */
  async analyzeCode(params: CodeAnalysisParams): Promise<CodeAnalysisResult> {
    const code = params.code_snippet;
    const analysisType = params.analysis_type || "comprehensive";

    const result: CodeAnalysisResult = {
      issues: [],
      patterns_detected: [],
      optimization_opportunities: [],
      suggested_topics: [],
    };

    // PRIORITY 1: Detect custom patterns from company/project/team layers first
    // These are explicitly defined standards and take precedence
    const customDetections = await this.detectCustomPatterns(code);

    // Add custom pattern violations to results
    for (const detection of customDetections) {
      result.patterns_detected.push(detection.topicId);
      
      // Map company/project standards to semantic types based on severity
      const issueType: "anti-pattern" | "warning" = 
        detection.severity === "critical" || detection.severity === "high" 
          ? "anti-pattern" 
          : "warning";
      
      result.issues.push({
        type: issueType,
        severity: detection.severity as "critical" | "high" | "medium" | "low",
        description: detection.description,
        suggestion: `Fix ${detection.matches} violation(s) - see topic ${detection.topicId}`,
        related_topics: [detection.topicId],
      });
    }

    // PRIORITY 2: Detect patterns in the code using relevance/regex
    const detectedPatterns = await this.detectPatterns(code);

    // Check company standards (policy-based rules without regex)
    const standardsViolations = await this.checkCompanyStandards(
      code,
      params.bc_version,
    );

    // Filter patterns based on analysis type
    const filteredPatterns = this.filterPatternsByAnalysisType(
      detectedPatterns,
      analysisType,
    );
    result.patterns_detected.push(...filteredPatterns.map((p) => p.name));

    // Analyze for issues and opportunities
    for (const pattern of filteredPatterns) {
      if (pattern.pattern_type === "bad") {
        result.issues.push({
          type: "anti-pattern",
          severity: this.calculateSeverity(pattern, code),
          description: pattern.description,
          suggestion: await this.generateSuggestion(pattern),
          related_topics: pattern.related_topics,
        });
      } else if (pattern.pattern_type === "good") {
        result.issues.push({
          type: "best-practice",
          severity: "low",
          description: pattern.description,
          suggestion: "Continue following this pattern",
          related_topics: pattern.related_topics,
        });
      }
    }

    // Add company standards violations (convert to proper issue format)
    result.issues.push(
      ...standardsViolations.map((v) => ({
        type: "warning" as const,
        severity: v.severity,
        description: v.description,
        suggestion: v.suggestion,
        related_topics: v.related_topics,
      })),
    );

    // Generate optimization opportunities
    result.optimization_opportunities =
      await this.findOptimizationOpportunities(code, detectedPatterns);

    // Suggest relevant topics if requested
    if (params.suggest_topics) {
      result.suggested_topics = await this.suggestTopics(
        code,
        detectedPatterns,
        params.bc_version,
      );
    }

    return result;
  }

  /**
   * Detect custom patterns from topics with detection.pattern frontmatter
   * This runs BEFORE standard relevance detection to prioritize company/project standards
   */
  private async detectCustomPatterns(code: string): Promise<
    Array<{
      topicId: string;
      title: string;
      matches: number;
      severity: string;
      description: string;
      layer: string;
      layerPriority: number;
    }>
  > {
    const detections: Array<{
      topicId: string;
      title: string;
      matches: number;
      severity: string;
      description: string;
      layer: string;
      layerPriority: number;
    }> = [];

    try {
      // Get ALL topics from all layers (this includes company/project topics)
      // Access layerService through knowledgeService
      const layerService = (this.knowledgeService as any).layerService;
      if (!layerService || !layerService.getAllTopicIds) {
        console.error(
          "⚠️ LayerService not available for custom pattern detection",
        );
        return detections;
      }

      const allTopicIds = layerService.getAllTopicIds();

      for (const topicId of allTopicIds) {
        const topic = await this.knowledgeService.getTopic(topicId);
        if (!topic) continue;

        // Check for detection field in frontmatter (with type safety)
        const detection = (topic.frontmatter as any).detection;

        if (detection && detection.enabled && detection.pattern) {
          try {
            const regex = new RegExp(detection.pattern, "gi");
            const matches = code.match(regex);

            if (matches && matches.length > 0) {
              console.error(
                `✅ Custom pattern detected: ${topicId} (${matches.length} matches) from layer ${topic.sourceLayer} (priority ${topic.layerPriority})`,
              );

              detections.push({
                topicId: topic.id,
                title: topic.title,
                matches: matches.length,
                severity:
                  topic.frontmatter.severity ||
                  detection.check_type ||
                  "warning",
                description: topic.frontmatter.description || topic.title,
                layer: topic.sourceLayer || "unknown",
                layerPriority: topic.layerPriority || 0,
              });
            }
          } catch (error) {
            console.error(`⚠️ Invalid regex pattern in ${topicId}:`, error);
          }
        }
      }

      // Sort by layer priority (highest first) so project > team > company
      detections.sort((a, b) => b.layerPriority - a.layerPriority);
    } catch (error) {
      console.error("Error detecting custom patterns:", error);
    }

    return detections;
  }

  /**
   * Detect AL patterns in code
   *
   * V2 Behavior (with RelevanceIndexService):
   *   Uses knowledge-driven relevance matching
   *
   * Legacy Behavior (without RelevanceIndexService):
   *   Falls back to regex-based pattern matching
   */
  private async detectPatterns(code: string): Promise<ALCodePattern[]> {
    // V2: Use relevance-based detection if available
    if (this.useRelevanceBasedDetection && this.relevanceIndexService) {
      return this.detectPatternsV2(code);
    }

    // Legacy: Fall back to regex-based detection
    return this.detectPatternsLegacy(code);
  }

  /**
   * V2: Knowledge-driven pattern detection
   */
  private async detectPatternsV2(code: string): Promise<ALCodePattern[]> {
    const relevantTopics = await this.relevanceIndexService!.findRelevantTopics(
      code,
      {
        limit: 20,
        minScore: 0.3,
        includeLegacyTopics: true, // Include topics without relevance_signals
      },
    );

    console.error(
      `🔍 detectPatternsV2: Found ${relevantTopics.length} relevant topics`,
    );

    // Store for handler enrichment
    this.lastRelevanceMatches = relevantTopics;

    const patterns: ALCodePattern[] = [];

    for (const match of relevantTopics) {
      const topic = await this.knowledgeService.getTopic(match.topicId);
      if (!topic) continue;

      const fm = topic.frontmatter;

      patterns.push({
        name: match.topicId,
        pattern_type:
          (fm.pattern_type as "good" | "bad" | "unknown") || "unknown",
        regex_patterns: [], // Not used in V2 detection
        description: fm.description || topic.title,
        related_topics: fm.related_topics || [],
        severity: fm.severity,
        category: fm.category,
        impact_level: fm.impact_level,
        detection_confidence: this.scoreToConfidence(match.relevanceScore),
      });
    }

    // If no V2 results, fall back to legacy patterns
    if (patterns.length === 0) {
      console.error("🔍 detectPatternsV2: No matches, falling back to legacy");
      return this.detectPatternsLegacy(code);
    }

    return patterns;
  }

  /**
   * Legacy: Regex-based pattern detection (existing implementation)
   * Preserved for backward compatibility
   */
  private async detectPatternsLegacy(code: string): Promise<ALCodePattern[]> {
    const detected: ALCodePattern[] = [];
    const patterns = await this.loadPatterns();

    console.error(
      `🔍 detectPatternsLegacy: Testing ${patterns.length} patterns against code (${code.length} chars)`,
    );

    for (const pattern of patterns) {
      if (pattern.regex_patterns.length === 0) {
        continue; // Skip patterns without regex (policy-based only)
      }
      for (const regex of pattern.regex_patterns) {
        // Reset lastIndex to avoid stateful regex issues with the 'g' flag
        regex.lastIndex = 0;
        if (regex.test(code)) {
          detected.push(pattern);
          console.error(`  ✓ Pattern matched: ${pattern.name}`);
          break; // Don't add the same pattern multiple times
        }
      }
    }

    console.error(
      `🔍 detectPatternsLegacy: Found ${detected.length} matching patterns`,
    );
    return detected;
  }

  /**
   * Convert relevance score (0-1) to confidence level
   */
  private scoreToConfidence(score: number): "low" | "medium" | "high" {
    if (score >= 0.7) return "high";
    if (score >= 0.5) return "medium";
    return "low";
  }

  /**
   * Check organization standards and guidelines (policy-based, not regex-based)
   * These are extracted from company AND project knowledge layers and evaluated semantically
   * Project layer standards override company layer standards due to higher priority
   */
  private async checkCompanyStandards(
    code: string,
    bcVersion?: string,
  ): Promise<
    Array<{
      type: string;
      severity: "low" | "medium" | "high" | "critical";
      description: string;
      suggestion: string;
      related_topics: string[];
    }>
  > {
    const violations: Array<{
      type: string;
      severity: "low" | "medium" | "high" | "critical";
      description: string;
      suggestion: string;
      related_topics: string[];
    }> = [];

    try {
      // Get organization standards from patterns cache (company + project layers)
      const allPatterns = await this.loadPatterns();
      const companyStandards = allPatterns.filter(
        (p) => p.category === "company-standard",
      );

      for (const standard of companyStandards) {
        // Semantic matching - check if code relates to the standard
        const isRelevant = this.isStandardRelevantToCode(standard, code);

        if (isRelevant) {
          // This is a guideline that applies to this code
          violations.push({
            type: "company-standard",
            severity: (standard.severity as any) || "medium",
            description: standard.description,
            suggestion: `Review organization standard: ${standard.description}`,
            related_topics: standard.related_topics,
          });
        }
      }

      console.error(
        `✅ Checked ${companyStandards.length} organization standards (company + project), found ${violations.length} relevant guidelines`,
      );
    } catch (error) {
      console.warn("Failed to check company standards:", error);
    }

    return violations;
  }

  /**
   * Determine if a company standard is relevant to the given code
   * Uses keyword matching and context analysis
   */
  private isStandardRelevantToCode(
    standard: ALCodePattern,
    code: string,
  ): boolean {
    const description = standard.description.toLowerCase();
    const codeLower = code.toLowerCase();

    // Extract key terms from the standard description
    const keywords = [
      "tooltip",
      "caption",
      "field",
      "table",
      "page",
      "naming",
      "convention",
      "variable",
      "procedure",
      "function",
      "codeunit",
      "report",
      "query",
      "english",
      "dutch",
      "language",
      "comment",
      "documentation",
    ];

    // Check if standard mentions specific AL constructs present in code
    for (const keyword of keywords) {
      if (description.includes(keyword) && codeLower.includes(keyword)) {
        return true;
      }
    }

    // Check for object type matches
    const objectTypes = [
      "table",
      "page",
      "codeunit",
      "report",
      "query",
      "xmlport",
    ];
    for (const objType of objectTypes) {
      if (
        description.includes(objType) &&
        new RegExp(`\\b${objType}\\b`, "i").test(code)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Filter patterns based on analysis type
   */
  private filterPatternsByAnalysisType(
    patterns: ALCodePattern[],
    analysisType: string,
  ): ALCodePattern[] {
    if (analysisType === "comprehensive") {
      return patterns; // Return all patterns
    }

    return patterns.filter((pattern) => {
      const domain = pattern.related_topics?.[0] || "";
      const name = pattern.name.toLowerCase();

      switch (analysisType) {
        case "performance":
          return (
            domain === "performance" ||
            name.includes("performance") ||
            name.includes("optimization")
          );
        case "quality":
          return (
            domain === "code-quality" ||
            domain === "best-practices" ||
            pattern.pattern_type === "good"
          );
        case "security":
          return (
            domain === "security" ||
            name.includes("security") ||
            name.includes("permission")
          );
        case "patterns":
          return (
            pattern.pattern_type === "good" || pattern.pattern_type === "bad"
          );
        case "optimization":
          return (
            domain === "performance" ||
            name.includes("optimization") ||
            name.includes("performance") ||
            pattern.pattern_type === "bad"
          );
        case "general":
          return true; // General analysis includes all patterns with balanced coverage
        default:
          return true; // Return all for unknown types
      }
    });
  }

  /**
   * Calculate severity of detected issues
   */
  private calculateSeverity(
    pattern: ALCodePattern,
    code: string,
  ): "low" | "medium" | "high" | "critical" {
    // Performance anti-patterns are generally more severe
    if (
      pattern.name.includes("manual-summation") ||
      pattern.name.includes("missing-setloadfields")
    ) {
      // Check if it's in a loop or processing large datasets
      if (
        /repeat.*until.*\.Next\(\)/.test(code) ||
        /FindSet.*repeat/.test(code)
      ) {
        return "high";
      }
      return "medium";
    }

    // Validation issues
    if (pattern.name.includes("missing-validation")) {
      return "medium";
    }

    // Default severity
    return "low";
  }

  /**
   * Load code analysis suggestions dynamically from layer topics
   *
   * Searches for topics with path: code-analysis/suggestions/{suggestion-id}
   * Falls back to hardcoded suggestions if topic not found
   */
  private async loadSuggestions(): Promise<Map<string, string>> {
    // Check cache first
    if (this.suggestionsCache && Date.now() < this.suggestionsCacheExpiry) {
      return this.suggestionsCache;
    }

    const suggestions = new Map<string, string>();

    try {
      // Search for all code-analysis suggestion topics across all layers
      const layerService = (this.knowledgeService as any).layerService;

      if (layerService) {
        // Get all topic IDs and filter for code-analysis/suggestions/*
        const allTopicIds = layerService.getAllTopicIds();
        const suggestionTopicIds = allTopicIds.filter(
          (id: string) =>
            id.startsWith("code-analysis/suggestions/") ||
            id.includes("/code-analysis/suggestions/"),
        );

        console.error(
          `🔍 Found ${suggestionTopicIds.length} code analysis suggestion topics in layers`,
        );

        // Load each suggestion topic
        for (const topicId of suggestionTopicIds) {
          const resolution = await layerService.resolveTopic(topicId);
          if (resolution && resolution.topic) {
            const topic = resolution.topic;

            // Extract suggestion ID from topic path
            // Supports both: "code-analysis/suggestions/manual-summation-instead-of-sift"
            // and: "performance/code-analysis/suggestions/manual-summation-instead-of-sift"
            const suggestionIdMatch = topicId.match(
              /code-analysis\/suggestions\/([^/]+)$/,
            );
            if (suggestionIdMatch) {
              const suggestionId = suggestionIdMatch[1];

              // Extract suggestion text from topic content
              // Look for first paragraph or use full content
              const suggestionText = this.extractSuggestionText(topic.content);

              suggestions.set(suggestionId, suggestionText);
              console.error(
                `  ✓ Loaded suggestion: ${suggestionId} from layer ${resolution.sourceLayer}`,
              );
            }
          }
        }

        console.error(
          `📋 Loaded ${suggestions.size} code analysis suggestions from layers`,
        );
      }
    } catch (error) {
      console.warn("Failed to load suggestions from knowledge layers:", error);
    }

    // Update cache
    this.suggestionsCache = suggestions;
    this.suggestionsCacheExpiry = Date.now() + this.CACHE_TTL;

    return suggestions;
  }

  /**
   * Extract suggestion text from topic content
   * Extracts the main suggestion text, typically from the first paragraph
   */
  private extractSuggestionText(content: string): string {
    // Remove YAML frontmatter if present
    const contentWithoutFrontmatter = content.replace(
      /^---[\s\S]*?---\n*/m,
      "",
    );

    // Split into paragraphs
    const paragraphs = contentWithoutFrontmatter
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#"));

    // Return first non-heading paragraph, or first 500 chars
    const suggestionText =
      paragraphs[0] || contentWithoutFrontmatter.substring(0, 500);

    // Clean up any remaining markdown formatting for inline use
    return suggestionText
      .replace(/\n+/g, " ")
      .replace(/\*\*/g, "")
      .replace(/`/g, "'")
      .trim();
  }

  /**
   * Generate improvement suggestions
   *
   * Dynamically loads suggestions from layer topics with fallback to hardcoded values
   */
  private async generateSuggestion(pattern: ALCodePattern): Promise<string> {
    // Try to load from layers first
    const dynamicSuggestions = await this.loadSuggestions();

    if (dynamicSuggestions.has(pattern.name)) {
      return dynamicSuggestions.get(pattern.name)!;
    }

    // Fallback to hardcoded suggestions
    // TODO: These hardcoded suggestions should be migrated to embedded-knowledge/topics/code-analysis/suggestions/
    // Each suggestion should be a separate markdown file with naming pattern: {pattern-name}.md
    // Example: embedded-knowledge/topics/code-analysis/suggestions/manual-summation-instead-of-sift.md
    const fallbackSuggestions: Record<string, string> = {
      // Performance suggestions
      "manual-summation-instead-of-sift":
        "Replace manual summation loop with SIFT CalcSums method. Example: Record.CalcSums(Amount) instead of looping through records.",
      "missing-setloadfields":
        'Add SetLoadFields before FindSet to only load required fields. Example: SetLoadFields("No.", "Name") before accessing these fields.',
      "individual-calcfields-calls":
        'Combine multiple CalcFields calls into a single call. Example: CalcFields("Field1", "Field2", "Field3")',
      "inefficient-deleteall":
        "Replace record-by-record deletion with DeleteAll method for better performance.",

      // Security suggestions
      "missing-permission-check":
        "Add permission validation before user or database access. Example: if not UserPermissions.Get(UserId) then Error('Access denied');",
      "hardcoded-credentials":
        "Move credentials to secure configuration. Use IsolatedStorage or Azure Key Vault instead of hardcoded values.",
      "sql-injection-risk":
        "Use parameterized queries instead of string concatenation. Avoid direct SQL concatenation with user input.",

      // Validation suggestions
      "missing-validation":
        "Add appropriate validation using TestField or custom validation logic before record operations.",
      "weak-field-validation":
        "Replace basic empty checks with TestField for better user experience and consistency.",
      "missing-range-validation":
        "Add range validation for numeric fields. Example: if Amount <= 0 then FieldError(Amount, 'must be positive');",

      // Error handling suggestions
      "silent-error-handling":
        "Implement proper error handling with user feedback. Avoid silent failures that hide issues from users.",
      "missing-transaction-handling":
        "Wrap multiple data operations in transaction handling for data consistency.",

      // Data safety suggestions
      "unsafe-bulk-operations":
        "Add filters before bulk operations. Use SetRange to limit scope of DeleteAll/ModifyAll operations.",
      "missing-backup-validation":
        "Add user confirmation before destructive operations. Use Confirm dialog for delete operations.",

      // Code quality suggestions
      "excessive-nesting":
        "Reduce nesting depth through guard clauses and early returns. Extract complex logic into separate procedures.",
      "magic-numbers":
        "Replace magic numbers with named constants. Example: const DaysInYear = 365;",

      // Architecture suggestions
      "tight-coupling":
        "Use interfaces to reduce coupling between objects. Implement dependency injection patterns.",

      // UX suggestions
      "poor-error-messages":
        "Provide clear, actionable error messages with context. Use StrSubstNo for formatted messages.",
      "missing-progress-indication":
        "Add progress indicators for long-running operations. Use Dialog.Open and Dialog.Update.",

      // API design suggestions
      "inconsistent-api-design":
        "Standardize API naming conventions. Use consistent Get/Find patterns across procedures.",
    };

    return (
      fallbackSuggestions[pattern.name] ||
      "Consider reviewing this pattern for optimization opportunities."
    );
  }

  /**
   * Find optimization opportunities based on detected patterns
   */
  private async findOptimizationOpportunities(
    code: string,
    detectedPatterns: ALCodePattern[],
  ): Promise<
    Array<{
      description: string;
      impact: "low" | "medium" | "high";
      difficulty: "easy" | "moderate" | "complex";
      related_topics: string[];
    }>
  > {
    const opportunities: Array<{
      description: string;
      impact: "low" | "medium" | "high";
      difficulty: "easy" | "moderate" | "complex";
      related_topics: string[];
    }> = [];

    // Performance opportunities
    if (this.hasLoopedAggregation(code) && !this.hasSIFTUsage(code)) {
      opportunities.push({
        description:
          "Implement SIFT indexes for aggregation queries to improve performance by 10-100x",
        impact: "high",
        difficulty: "moderate",
        related_topics: [
          "sift-technology-fundamentals",
          "maintainsiftindex-property-behavior",
        ],
      });
    }

    if (this.hasMultipleFieldAccess(code) && !this.hasSetLoadFields(code)) {
      opportunities.push({
        description:
          "Use SetLoadFields to reduce memory usage and network traffic by 50-80%",
        impact: "medium",
        difficulty: "easy",
        related_topics: ["memory-optimization", "setloadfields-optimization"],
      });
    }

    // Security opportunities
    if (this.hasSecurityRisks(code)) {
      opportunities.push({
        description:
          "Implement proper security validation and permission checks",
        impact: "high",
        difficulty: "moderate",
        related_topics: [
          "security-fundamentals",
          "user-permissions",
          "access-control",
        ],
      });
    }

    // Code quality opportunities
    if (this.hasCodeQualityIssues(code)) {
      opportunities.push({
        description:
          "Refactor code to improve readability, maintainability, and reduce complexity",
        impact: "medium",
        difficulty: "moderate",
        related_topics: [
          "refactoring-patterns",
          "code-complexity",
          "maintainability",
        ],
      });
    }

    // Error handling opportunities
    if (this.hasPoorErrorHandling(code)) {
      opportunities.push({
        description:
          "Implement comprehensive error handling with proper user feedback",
        impact: "medium",
        difficulty: "easy",
        related_topics: [
          "error-handling-patterns",
          "user-experience",
          "debugging-strategies",
        ],
      });
    }

    // Data safety opportunities
    if (this.hasDataSafetyRisks(code)) {
      opportunities.push({
        description:
          "Add data protection measures and user confirmations for destructive operations",
        impact: "high",
        difficulty: "easy",
        related_topics: [
          "data-safety-patterns",
          "user-confirmation",
          "data-protection",
        ],
      });
    }

    // Architecture opportunities
    if (this.hasArchitectureIssues(code)) {
      opportunities.push({
        description:
          "Improve architecture with better separation of concerns and loose coupling",
        impact: "medium",
        difficulty: "complex",
        related_topics: [
          "clean-architecture",
          "interface-design",
          "dependency-management",
        ],
      });
    }

    // User experience opportunities
    if (this.hasUXIssues(code)) {
      opportunities.push({
        description:
          "Enhance user experience with better feedback, progress indicators, and error messages",
        impact: "medium",
        difficulty: "easy",
        related_topics: [
          "user-experience",
          "progress-indicators",
          "error-message-design",
        ],
      });
    }

    return opportunities;
  }

  /**
   * Suggest relevant topics based on code analysis
   */
  private async suggestTopics(
    code: string,
    detectedPatterns: ALCodePattern[],
    bcVersion?: string,
  ): Promise<TopicSearchResult[]> {
    // V2: Use relevance index if available
    if (this.useRelevanceBasedDetection && this.relevanceIndexService) {
      const relevantTopics =
        await this.relevanceIndexService.findRelevantTopics(code, {
          limit: 10,
          minScore: 0.5,
        });

      const results: TopicSearchResult[] = [];

      for (const match of relevantTopics) {
        const topic = await this.knowledgeService.getTopic(match.topicId);
        if (!topic) continue;

        const fm = topic.frontmatter;
        const domains = Array.isArray(fm.domain)
          ? fm.domain
          : [fm.domain || "unknown"];

        results.push({
          id: match.topicId,
          title: topic.title,
          domain: domains[0],
          domains: domains.length > 1 ? domains : undefined,
          difficulty: fm.difficulty,
          relevance_score: match.relevanceScore,
          summary: topic.content.substring(0, 200) + "...",
          tags: fm.tags || [],
          prerequisites: fm.prerequisites || [],
          estimated_time: fm.estimated_time,
        });
      }

      return results;
    }

    // Legacy: Use existing implementation
    // Collect all related topics from detected patterns
    const relatedTopicIds = new Set<string>();
    for (const pattern of detectedPatterns) {
      pattern.related_topics.forEach((topic) => relatedTopicIds.add(topic));
    }

    // Add contextual topics based on code content
    const codeContext = this.extractCodeContext(code);

    const searchResults = await this.knowledgeService.searchTopics({
      code_context: codeContext,
      bc_version: bcVersion,
      limit: 10,
    });

    // Combine explicit related topics with search results
    const allSuggestions = new Map<string, TopicSearchResult>();

    // Add search results
    for (const result of searchResults) {
      allSuggestions.set(result.id, result);
    }

    // Enhance with explicitly related topics
    for (const topicId of relatedTopicIds) {
      if (!allSuggestions.has(topicId)) {
        const topic = await this.knowledgeService.getTopic(topicId);
        if (topic && topic.frontmatter) {
          const domains = getDomainList(topic.frontmatter.domain);
          allSuggestions.set(topicId, {
            id: topic.id,
            title: topic.frontmatter.title || topicId,
            domain: domains[0] || "unknown",
            domains: domains.length > 1 ? domains : undefined,
            difficulty: topic.frontmatter.difficulty,
            relevance_score: 0.9, // High relevance for explicitly related topics
            summary: (topic.content || "").substring(0, 200) + "...",
            tags: topic.frontmatter.tags,
            prerequisites: topic.frontmatter.prerequisites || [],
            estimated_time: topic.frontmatter.estimated_time,
          });
        }
      }
    }

    return Array.from(allSuggestions.values())
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 8); // Return top 8 suggestions
  }

  /**
   * Extract meaningful context from code for search
   */
  private extractCodeContext(code: string): string {
    const contexts: string[] = [];

    // Extract comprehensive context across all domains
    if (/table\s+\d+/.test(code)) contexts.push("table design");
    if (/FindSet|FindFirst|FindLast/.test(code))
      contexts.push("record iteration");
    if (/CalcFields|CalcSums/.test(code)) contexts.push("field calculations");
    if (/SetRange|SetFilter/.test(code)) contexts.push("filtering");
    if (/Insert|Modify|Delete/.test(code)) contexts.push("data modification");

    // Security context
    if (/User\.|Permission|Security/.test(code)) contexts.push("security");
    if (/password|token|secret|credential/i.test(code))
      contexts.push("credential management");
    if (/Database\.Execute|SELECTSQL/.test(code))
      contexts.push("database security");

    // Validation context
    if (/TestField|FieldError|Validate/.test(code)) contexts.push("validation");
    if (/Confirm\s*\(/.test(code)) contexts.push("user confirmation");

    // Error handling context
    if (/Error\s*\(|GetLastError|ClearLastError/.test(code))
      contexts.push("error handling");
    if (/try|catch|Codeunit\.Run/.test(code))
      contexts.push("exception management");

    // Architecture context
    if (/EventSubscriber|IntegrationEvent/.test(code))
      contexts.push("event architecture");
    if (/interface|implements/.test(code)) contexts.push("clean architecture");
    if (/Codeunit\s*::|Page\s*::|Report\s*::/.test(code))
      contexts.push("object coupling");

    // Performance context
    if (/repeat.*until.*Next/.test(code)) contexts.push("record loops");
    if (/FlowField|CalcFormula/.test(code)) contexts.push("flowfields");
    if (/SetLoadFields/.test(code)) contexts.push("memory optimization");

    // User experience context
    if (/Dialog\.|Window\.|Message\s*\(/.test(code))
      contexts.push("user feedback");
    if (/Progress|Update/.test(code)) contexts.push("progress indication");

    // Code quality context
    if ((code.match(/if/gi) || []).length > 5) contexts.push("code complexity");
    if (/\b\d{3,}\b/.test(code)) contexts.push("magic numbers");

    // Data safety context
    if (/DeleteAll|ModifyAll/.test(code)) contexts.push("bulk operations");
    if (/IsTemporary/.test(code)) contexts.push("temporary tables");

    // API design context
    if (/procedure.*Get.*Boolean|procedure.*Find.*Record/.test(code))
      contexts.push("api design");
    if (/webservice|restapi|soap/i.test(code)) contexts.push("web services");

    return contexts.join(" ");
  }

  // Performance pattern detection
  private hasLoopedAggregation(code: string): boolean {
    return /repeat[\s\S]*?\+=[\s\S]*?until.*\.Next\(\)/.test(code);
  }

  private hasSIFTUsage(code: string): boolean {
    return /CalcSums\s*\(/.test(code);
  }

  private hasMultipleFieldAccess(code: string): boolean {
    return /FindSet\(\)[\s\S]*?repeat[\s\S]*?(\w+\."[^"]*"\s*[,;].*){3,}/.test(
      code,
    );
  }

  private hasSetLoadFields(code: string): boolean {
    return /SetLoadFields\s*\(/.test(code);
  }

  private hasIndividualRecordOperations(code: string): boolean {
    return /repeat[\s\S]*?(Insert|Modify|Delete)\s*\([\s\S]*?until.*\.Next\(\)/.test(
      code,
    );
  }

  private hasManualCalculations(code: string): boolean {
    return /repeat[\s\S]*?(\+=|\*=|\/=)[\s\S]*?until.*\.Next\(\)/.test(code);
  }

  // Security pattern detection
  private hasSecurityRisks(code: string): boolean {
    return (
      /User\.Get\s*\([^)]+\)(?!.*Permission)/.test(code) ||
      /password\s*:=\s*'[^']+'/i.test(code) ||
      /Database\.Execute\s*\([^)]*\+/.test(code)
    );
  }

  // Code quality pattern detection
  private hasCodeQualityIssues(code: string): boolean {
    const nestingLevel = (code.match(/if[\s\S]*?begin/gi) || []).length;
    const magicNumbers = /\b\d{3,}\b/.test(code);
    const longProcedures =
      code.split("procedure").length > 1 && code.length > 2000;
    return nestingLevel > 3 || magicNumbers || longProcedures;
  }

  // Error handling pattern detection
  private hasPoorErrorHandling(code: string): boolean {
    const hasOperations = /(Insert|Modify|Delete|Codeunit\.Run)\s*\(/.test(
      code,
    );
    const hasErrorHandling = /if.*not.*then[\s\S]*?Error|try[\s\S]*?catch/.test(
      code,
    );
    return hasOperations && !hasErrorHandling;
  }

  // Data safety pattern detection
  private hasDataSafetyRisks(code: string): boolean {
    return (
      /DeleteAll\s*\(\s*\)(?!.*SetRange)/.test(code) ||
      /Delete\s*\((?:true)?\)(?!.*Confirm)/.test(code) ||
      /ModifyAll\s*\([^)]*\)(?!.*SetRange)/.test(code)
    );
  }

  // Architecture pattern detection
  private hasArchitectureIssues(code: string): boolean {
    const tightCoupling = /Codeunit\s*::\s*"[^"]*"\s*\.[A-Za-z]+/.test(code);
    const noInterfaces =
      !/(interface|implements)\s+"/.test(code) && code.includes("procedure");
    return tightCoupling || (noInterfaces && code.length > 1000);
  }

  // User experience pattern detection
  private hasUXIssues(code: string): boolean {
    const hasLongProcess = /repeat[\s\S]*?until.*\.Next\(\)/.test(code);
    const hasProgressFeedback = /Dialog\.(Open|Update)|Window\.Update/.test(
      code,
    );
    const hasGenericErrors = /Error\s*\(\s*'[^']{1,20}'\s*\)/.test(code);
    return (hasLongProcess && !hasProgressFeedback) || hasGenericErrors;
  }
}
