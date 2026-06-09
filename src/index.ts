#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import {
  allTools,
  debugTools,
  workspaceTools as workspaceToolSchemas,
  STREAMLINED_TOOL_NAMES,
} from "./tools/index.js";
import {
  createToolHandlers,
  createDebugToolHandlers,
  type HandlerServices,
  type WorkspaceContext,
} from "./tools/handlers.js";
import { KnowledgeService } from "./services/knowledge-service.js";
import { CodeAnalysisService } from "./services/code-analysis-service.js";
import { MethodologyService } from "./services/methodology-service.js";
import { WorkflowService } from "./services/workflow-service.js";
import { WorkflowSessionManager } from "./services/workflow-v2/workflow-session-manager.js";
import { RelevanceIndexService } from "./services/relevance-index-service.js";
import { getDomainList } from "./types/bc-knowledge.js";
import { MultiContentLayerService } from "./services/multi-content-layer-service.js";
import { SpecialistSessionManager } from "./services/specialist-session-manager.js";
import { SpecialistDiscoveryService } from "./services/specialist-discovery.js";
import { WorkflowSpecialistRouter } from "./services/workflow-specialist-router.js";
import { ConfigurationLoader } from "./config/config-loader.js";
import { ConfigurationValidator } from "./config/config-validator.js";
import {
  TopicSearchParams,
  CodeAnalysisParams,
  BCKBConfig,
} from "./types/bc-knowledge.js";
import { SpecialistDefinition } from "./services/specialist-loader.js";
import {
  WorkflowType,
  WorkflowStartRequest,
  WorkflowAdvanceRequest,
} from "./services/workflow-service.js";
import {
  BCCodeIntelConfiguration,
  ConfigurationLoadResult,
  LayerSourceType,
} from "./types/index.js";

/**
 * BC Code Intelligence MCP Server
 *
 * Business Central Code Intelligence Model Context Protocol Server
 * Surfaces atomic BC knowledge topics for intelligent AI consumption
 * via GitHub Copilot, Claude, and other LLM tools.
 */
class BCCodeIntelligenceServer {
  private server: Server;
  private knowledgeService!: KnowledgeService;
  private codeAnalysisService!: CodeAnalysisService;
  private methodologyService!: MethodologyService;
  private workflowService!: WorkflowService;
  private relevanceIndexService!: RelevanceIndexService;
  private layerService!: MultiContentLayerService;
  private specialistSessionManager!: SpecialistSessionManager;
  private specialistDiscoveryService!: SpecialistDiscoveryService;
  private workflowSpecialistRouter!: WorkflowSpecialistRouter;
  private workflowSessionManager!: WorkflowSessionManager;
  private configuration!: BCCodeIntelConfiguration;
  private configLoader: ConfigurationLoader;
  private workspaceRoot: string | null = null;
  private availableMcps: string[] = [];
  private hasWarnedAboutWorkspace = false;
  private toolHandlers!: Map<string, (args: any) => Promise<any>>;
  private debugToolHandlers!: Map<string, (args: any) => Promise<any>>;
  private servicesInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  private getPackageVersion(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const packagePath = join(__dirname, "..", "package.json");

      console.error(`🔍 Looking for package.json at: ${packagePath}`);
      console.error(`   Exists: ${existsSync(packagePath)}`);

      if (!existsSync(packagePath)) {
        console.error(`⚠️  package.json not found at expected location`);
        return "1.0.0"; // fallback
      }

      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      const version = packageJson.version || "1.0.0";
      console.error(`   Version: ${version}`);
      return version;
    } catch (error) {
      console.error(
        `⚠️  Error reading package.json:`,
        error instanceof Error ? error.message : String(error),
      );
      return "1.0.0"; // fallback
    }
  }

  constructor() {
    // Log startup diagnostics
    console.error(`[startup] MCP Server starting...`);
    console.error(`[startup] Process CWD: ${process.cwd()}`);
    console.error(`[startup] Node version: ${process.version}`);

    // Initialize MCP server with capabilities declaration (required by SDK 1.x)
    this.server = new Server(
      {
        name: "bc-code-intelligence-mcp",
        version: this.getPackageVersion(),
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      },
    );

    // Initialize configuration loader
    this.configLoader = new ConfigurationLoader();

    // Initialize workspace tool handlers (these work before services are initialized)
    const workspaceContext: WorkspaceContext = {
      setWorkspaceInfo: this.setWorkspaceInfo.bind(this),
      getWorkspaceInfo: this.getWorkspaceInfo.bind(this),
    };
    this.toolHandlers = createToolHandlers(
      {} as HandlerServices,
      workspaceContext,
    );

    // Services will be initialized asynchronously in run()
    this.setupToolHandlers();
    this.setupPrompts();
  }

  private setupToolHandlers(): void {
    // List available tools - now using streamlined tool arrays
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [...allTools];

      // Add configuration diagnostic tools if enabled
      if (this.debugToolHandlers && this.debugToolHandlers.size > 0) {
        tools.push(...debugTools);
      }

      return { tools };
    });

    // Handle tool calls - now using centralized tool names
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Workspace tools are always available (no interception)
        if (["set_workspace_info", "get_workspace_info"].includes(name)) {
          const handler = this.toolHandlers.get(name);
          if (!handler) {
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown workspace tool: ${name}`,
            );
          }
          return await handler(args);
        }

        // Intercept all other tools if services not initialized
        if (!this.servicesInitialized) {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ **Server Not Yet Initialized**

The server will automatically initialize when you call set_workspace_info with your workspace path.

For CLI usage, this should happen automatically. If you see this message, there may be an initialization error.`,
              },
            ],
          };
        }

        // Try debug tool handlers first (if enabled)
        if (this.debugToolHandlers && this.debugToolHandlers.has(name)) {
          const handler = this.debugToolHandlers.get(name)!;
          return await handler(args);
        }

        // Execute main tool handler
        const handler = this.toolHandlers.get(name);
        if (!handler) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return await handler(args);
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  /**
   * Setup prompts for workflow pipelines
   */
  private setupPrompts(): void {
    console.error("🎯 Setting up MCP Prompts for workflow pipelines...");

    // Define workflow prompts that guide users through structured pipelines
    const workflowPrompts = [
      {
        name: "code_optimization",
        description:
          "Optimize existing Business Central code using systematic analysis phases",
        arguments: [
          {
            name: "code_location",
            description:
              "Path to the code file or description of the code to optimize",
            required: false, // No more required fields - specialist will ask conversationally
          },
        ],
      },
      {
        name: "architecture_review",
        description:
          "Conduct comprehensive architecture review of Business Central solution",
        arguments: [
          {
            name: "scope",
            description:
              "Scope of review (module, solution, or specific components)",
            required: false, // Specialist will ask about scope naturally
          },
        ],
      },
      {
        name: "security_audit",
        description:
          "Perform security analysis and compliance check for Business Central implementation",
        arguments: [
          {
            name: "audit_scope",
            description:
              "Security audit scope (permissions, data access, API security, etc.)",
            required: false, // Specialist will gather this in conversation
          },
        ],
      },
      {
        name: "perf_review",
        description: "Analyze and optimize Business Central performance issues",
        arguments: [
          {
            name: "performance_concern",
            description: "Description of performance issue or area to analyze",
            required: false,
          },
        ],
      },
      {
        name: "integration_design",
        description: "Design robust integration patterns for Business Central",
        arguments: [
          {
            name: "integration_type",
            description:
              "Type of integration (API, data sync, external service, etc.)",
            required: false,
          },
        ],
      },
      {
        name: "upgrade_planning",
        description:
          "Plan Business Central version upgrade with risk assessment",
        arguments: [
          {
            name: "current_version",
            description: "Current Business Central version",
            required: false,
          },
          {
            name: "target_version",
            description: "Target Business Central version",
            required: false,
          },
        ],
      },
      {
        name: "testing_strategy",
        description:
          "Develop comprehensive testing strategy for Business Central solutions",
        arguments: [
          {
            name: "testing_scope",
            description:
              "Scope of testing (unit, integration, user acceptance, etc.)",
            required: false,
          },
        ],
      },
      {
        name: "dev_onboarding",
        description:
          "Guide new developer through Business Central development onboarding",
        arguments: [
          {
            name: "experience_level",
            description:
              "Developer experience level (beginner, intermediate, expert)",
            required: false,
          },
          {
            name: "focus_area",
            description:
              "Primary focus area for onboarding (development, customization, integration)",
            required: false,
          },
        ],
      },
      {
        name: "app_takeover",
        description:
          "Analyze and orient developer taking over an unfamiliar Business Central app",
        arguments: [
          {
            name: "app_source",
            description:
              "Source of the app (path, repository, AppSource, or description)",
            required: false,
          },
          {
            name: "takeover_context",
            description:
              "Context for takeover (maintenance, enhancement, migration, or handoff scenario)",
            required: false,
          },
        ],
      },
      {
        name: "spec_analysis",
        description:
          "Analyze requirements and specifications to determine development readiness",
        arguments: [
          {
            name: "spec_source",
            description:
              "Source of specifications (document, user story, requirements, or description)",
            required: false,
          },
          {
            name: "analysis_focus",
            description:
              "Analysis focus (completeness, feasibility, technical-gaps, or dependencies)",
            required: false,
          },
        ],
      },
      {
        name: "bug_investigation",
        description:
          "Systematically investigate and resolve Business Central bugs and issues",
        arguments: [
          {
            name: "bug_context",
            description:
              "Available context (call-stack, repro-steps, snapshot, sandbox-access, or description)",
            required: false,
          },
          {
            name: "issue_severity",
            description: "Issue severity level (critical, high, medium, low)",
            required: false,
          },
        ],
      },
      {
        name: "monolith_to_modules",
        description:
          "Refactor monolithic Business Central code into modular architecture using SOLID principles",
        arguments: [
          {
            name: "current_structure",
            description:
              "Current code structure (monolithic-object, large-codeunit, tightly-coupled, or description)",
            required: false,
          },
          {
            name: "modularization_goal",
            description:
              "Modularization goal (dependency-injection, interface-patterns, loose-coupling, or testability)",
            required: false,
          },
        ],
      },
      {
        name: "data_flow_tracing",
        description:
          "Trace data flow and dependencies across Business Central objects and codeunits",
        arguments: [
          {
            name: "trace_target",
            description:
              "What to trace (field-usage, table-relationships, posting-flow, or process-chain)",
            required: false,
          },
          {
            name: "trace_scope",
            description:
              "Tracing scope (single-object, module-level, cross-module, or end-to-end)",
            required: false,
          },
        ],
      },
      {
        name: "full_review",
        description:
          "Conduct comprehensive review and analysis without implementation changes",
        arguments: [
          {
            name: "review_target",
            description:
              "What to review (code, architecture, documentation, processes)",
            required: false,
          },
          {
            name: "review_depth",
            description: "Review depth (surface, detailed, comprehensive)",
            required: false,
          },
        ],
      },
    ];

    // Register prompt list handler
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: workflowPrompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    }));

    // Register get prompt handler for all workflows
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const prompt = workflowPrompts.find((p) => p.name === name);
      if (!prompt) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
      }

      try {
        // Convert workflow name to type and create start request
        const workflowTypeMap: Record<string, string> = {
          code_optimization: "new-bc-app",
          architecture_review: "enhance-bc-app",
          security_audit: "debug-bc-issues",
          perf_review: "debug-bc-issues",
          integration_design: "add-ecosystem-features",
          upgrade_planning: "upgrade-bc-version",
          testing_strategy: "modernize-bc-code",
          dev_onboarding: "onboard-developer",
          app_takeover: "enhance-bc-app",
          spec_analysis: "review-bc-code",
          bug_investigation: "debug-bc-issues",
          monolith_to_modules: "modernize-bc-code",
          data_flow_tracing: "review-bc-code",
          full_review: "review-bc-code",
        };

        const workflowType = workflowTypeMap[name] as any;
        if (!workflowType) {
          throw new Error(`Unknown workflow type: ${name}`);
        }

        const startRequest = {
          workflow_type: workflowType,
          project_context:
            args?.code_location ||
            args?.scope ||
            args?.audit_scope ||
            args?.performance_concern ||
            args?.integration_type ||
            args?.testing_scope ||
            args?.review_target ||
            "General workflow request",
          bc_version: args?.target_version || args?.current_version,
          additional_context: args,
        };

        // Start the workflow session
        const session = await this.workflowService.startWorkflow(startRequest);

        // Get the initial guidance for this workflow
        const initialGuidance = await this.workflowService.getPhaseGuidance(
          session.id,
        );

        // Enhance with specialist routing
        const userContext =
          args?.code_location ||
          args?.scope ||
          args?.audit_scope ||
          args?.performance_concern ||
          args?.integration_type ||
          args?.testing_scope ||
          args?.review_target ||
          "General workflow request";

        const enhancedResult =
          await this.workflowSpecialistRouter.enhanceWorkflowPrompt(
            name,
            userContext,
            initialGuidance,
          );

        // Construct explicit prompt that bypasses VS Code prompt creation
        const promptContent = `# ${prompt.description}

**IMPORTANT: This is a complete, ready-to-use prompt. Do not create additional prompts or ask for more information. Proceed directly with the requested workflow.**

${enhancedResult.enhancedContent}

## 🎯 Next Actions

**Use these MCP tools immediately to proceed:**
${enhancedResult.routingOptions.map((option) => `- ${option.replace("🎯 Start session with", "**Use MCP tool:**")}`).join("\n")}

**Remember:** You have access to 20+ MCP tools from bc-code-intelligence-mcp. Use them actively for specialist consultation and knowledge access.`;

        return {
          description: `Starting ${workflowType} workflow with specialist guidance`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: promptContent,
              },
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to start workflow: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    console.error("✅ MCP Prompts configured for workflow orchestration");
  }

  /**
   * Initialize all services with configuration
   */
  private async initializeServices(
    configResult: ConfigurationLoadResult,
  ): Promise<void> {
    // Store configuration
    this.configuration = configResult.config;

    // Initialize layer service with configuration
    this.layerService = new MultiContentLayerService();
    let totalTopics = 0;

    // Initialize legacy knowledge service for backward compatibility
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const legacyConfig: BCKBConfig = {
      knowledge_base_path:
        process.env["BCKB_KB_PATH"] || join(__dirname, "../embedded-knowledge"),
      indexes_path:
        process.env["BCKB_INDEXES_PATH"] ||
        join(__dirname, "../embedded-knowledge/indexes"),
      workflows_path:
        process.env["BCKB_WORKFLOWS_PATH"] ||
        join(__dirname, "../embedded-knowledge/workflows"),
      cache_size: this.configuration.cache.max_size_mb * 1024, // Convert MB to entries approximation
      max_search_results: 20,
      default_bc_version: "BC22",
      enable_fuzzy_search: true,
      search_threshold: 0.6,
    };

    // Initialize specialist services using a dedicated MultiContentLayerService FIRST
    this.layerService = new MultiContentLayerService();

    // Iterate over configured layers and instantiate each based on type
    for (const layerConfig of this.configuration.layers) {
      if (!layerConfig.enabled) {
        console.error(`⏭️  Skipping disabled layer: ${layerConfig.name}`);
        continue;
      }

      let layer;

      try {
        switch (layerConfig.source.type) {
          case LayerSourceType.EMBEDDED: {
            // Embedded layer - ALWAYS use the server's embedded knowledge directory
            // The 'path' field is ignored for embedded layers since they reference the built-in knowledge
            const embeddedPath = join(__dirname, "../embedded-knowledge");

            console.error(
              `📋 Embedded layer using built-in knowledge: ${embeddedPath}`,
            );

            const { EmbeddedKnowledgeLayer } = await import(
              "./layers/embedded-layer.js"
            );
            layer = new EmbeddedKnowledgeLayer(embeddedPath);
            break;
          }

          case LayerSourceType.LOCAL: {
            // Local filesystem layer - use ProjectKnowledgeLayer
            const { ProjectKnowledgeLayer } = await import(
              "./layers/project-layer.js"
            );
            layer = new ProjectKnowledgeLayer(layerConfig.source.path!);
            // Override name and priority from config
            (layer as any).name = layerConfig.name;
            (layer as any).priority = layerConfig.priority;
            break;
          }

          case LayerSourceType.GIT: {
            // Git repository layer
            const { GitKnowledgeLayer } = await import("./layers/git-layer.js");
            const gitSource = layerConfig.source as any; // GitLayerSource
            layer = new GitKnowledgeLayer(
              layerConfig.name,
              layerConfig.priority,
              {
                type: LayerSourceType.GIT,
                url: gitSource.url,
                branch: gitSource.branch,
                subpath: gitSource.subpath,
              },
              layerConfig.auth,
            );
            break;
          }

          case LayerSourceType.HTTP:
          case LayerSourceType.NPM: {
            // Future layer types - not yet implemented
            // HTTP: Would load knowledge from HTTP endpoints (ZIP/tarball downloads)
            // NPM: Would load knowledge from NPM packages
            console.warn(
              `⚠️  Layer type '${layerConfig.source.type}' not yet implemented - skipping ${layerConfig.name}`,
            );
            continue;
          }

          default:
            console.error(
              `❌ Unknown layer type: ${(layerConfig.source as any).type} - skipping ${layerConfig.name}`,
            );
            continue;
        }

        console.error(
          `📋 Successfully instantiated layer: ${layerConfig.name}`,
        );
        this.layerService.addLayer(layer as any);
      } catch (layerError) {
        // CRITICAL FIX: Handle individual layer instantiation failures gracefully
        // This prevents one failing layer (e.g. git auth issues) from breaking the entire service
        console.error(
          `❌ Failed to instantiate layer '${layerConfig.name}': ${layerError instanceof Error ? layerError.message : String(layerError)}`,
        );

        if (layerConfig.source.type === LayerSourceType.GIT) {
          console.error(
            `💡 Git layer '${layerConfig.name}' failed - check repository URL, authentication, or network connection`,
          );
        } else if (layerConfig.source.type === LayerSourceType.LOCAL) {
          console.error(
            `💡 Local layer '${layerConfig.name}' failed - check that path '${layerConfig.source.path}' exists and is readable`,
          );
        }

        // Continue to next layer instead of aborting entire initialization
        continue;
      }
    }

    // START LAYER INITIALIZATION (MUST complete before services)
    await this.layerService.initialize();

    // Now create services with fully initialized layerService
    this.knowledgeService = new KnowledgeService(
      legacyConfig,
      this.layerService,
    );

    // V2: Create RelevanceIndexService for knowledge-driven detection
    this.relevanceIndexService = new RelevanceIndexService(this.layerService);

    // Initialize services (they'll use the already-initialized layer service)
    await Promise.all([
      this.knowledgeService.initialize(),
      this.relevanceIndexService.initialize(),
    ]);

    // Pass relevanceIndexService to enable V2 detection
    this.codeAnalysisService = new CodeAnalysisService(
      this.knowledgeService,
      this.relevanceIndexService,
    );
    this.methodologyService = new MethodologyService(
      this.knowledgeService,
      legacyConfig.workflows_path,
    );

    // Report layer-by-layer counts after initialization
    const layerStats = this.layerService.getStatistics();
    for (const stats of layerStats) {
      console.error(`📁 Layer '${stats.name}': ${stats.topicCount} topics`);
      totalTopics += stats.topicCount;
    }

    // Get session storage configuration from layer service
    const sessionStorageConfig = this.layerService.getSessionStorageConfig();

    this.specialistSessionManager = new SpecialistSessionManager(
      this.layerService,
      sessionStorageConfig,
    );

    // Initialize specialist discovery service
    this.specialistDiscoveryService = new SpecialistDiscoveryService(
      this.layerService,
    );

    // Initialize workflow service with specialist discovery
    this.workflowService = new WorkflowService(
      this.knowledgeService,
      this.methodologyService,
      this.specialistDiscoveryService,
    );

    // Initialize workflow specialist router for specialist routing
    this.workflowSpecialistRouter = new WorkflowSpecialistRouter(
      this.specialistDiscoveryService,
      this.specialistSessionManager,
      this.workflowService,
    );

    // Initialize workflow session manager for stateful workflow processing
    this.workflowSessionManager = new WorkflowSessionManager();
    if (this.workspaceRoot) {
      this.workflowSessionManager.setWorkspaceRoot(this.workspaceRoot);
    }

    // Create tool handlers with all service dependencies
    const workspaceContext: WorkspaceContext = {
      setWorkspaceInfo: this.setWorkspaceInfo.bind(this),
      getWorkspaceInfo: this.getWorkspaceInfo.bind(this),
    };

    const handlerServices: HandlerServices = {
      knowledgeService: this.knowledgeService,
      codeAnalysisService: this.codeAnalysisService,
      methodologyService: this.methodologyService,
      workflowService: this.workflowService,
      layerService: this.layerService,
      sessionManager: this.specialistSessionManager,
      discoveryService: this.specialistDiscoveryService,
      configLoader: this.configLoader,
      workflowSessionManager: this.workflowSessionManager,
    };

    this.toolHandlers = createToolHandlers(handlerServices, workspaceContext);

    // Initialize debug tool handlers ONLY if enabled (reduces token overhead)
    if (this.configuration.developer.enable_diagnostic_tools) {
      this.debugToolHandlers = createDebugToolHandlers(handlerServices);
      console.error("🔧 Configuration diagnostic tools enabled");
    } else {
      console.error(
        "💡 Tip: Set developer.enable_diagnostic_tools=true for git layer diagnostics",
      );
    }

    // Report final totals
    const specialists = await this.layerService.getAllSpecialists();
    const relevanceStats = this.relevanceIndexService.getStatistics();
    console.error(
      `📊 Total: ${totalTopics} topics, ${specialists.length} specialists`,
    );
    console.error(
      `🔍 Relevance Index: ${relevanceStats.totalTopics} indexed (${relevanceStats.v2Topics} V2, ${relevanceStats.legacyTopics} legacy)`,
    );

    // Validate tool contracts at startup
    await this.validateToolContracts();
  }

  /**
   * Validate that all tool schemas match service implementations
   */
  private async validateToolContracts(): Promise<void> {
    try {
      // Simple validation: ensure all tools in the registry have handlers
      const tools = [...allTools];
      if (this.debugToolHandlers && this.debugToolHandlers.size > 0) {
        tools.push(...debugTools);
      }

      for (const tool of tools) {
        const hasHandler =
          this.toolHandlers.has(tool.name) ||
          (this.debugToolHandlers && this.debugToolHandlers.has(tool.name));
        if (!hasHandler) {
          console.warn(`⚠️  Tool '${tool.name}' has no handler registered`);
        }
      }

      console.error(`✅ Validated ${tools.length} tool contracts`);
    } catch (error) {
      console.warn(
        `⚠️  Tool contract validation warning: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Generate comprehensive system analytics
   */
  private async generateSystemAnalytics(
    includeTopicAnalytics: boolean,
    includeLayerPerformance: boolean,
    includeConfigurationInsights: boolean,
  ): Promise<any> {
    const analytics = {
      timestamp: new Date().toISOString(),
      system_overview: {
        server_version: this.getPackageVersion(),
        layers_active: this.layerService?.getLayers().length || 0,
        configuration_loaded: !!this.configuration,
        total_topics: this.layerService?.getAllTopicIds().length || 0,
      },
    } as any;

    if (includeTopicAnalytics && this.layerService) {
      analytics.topic_analytics = await this.generateTopicAnalytics();
    }

    if (includeLayerPerformance && this.layerService) {
      analytics.layer_performance = this.generateLayerPerformanceAnalytics();
    }

    if (includeConfigurationInsights && this.configuration) {
      analytics.configuration_insights =
        await this.generateConfigurationInsights();
    }

    return analytics;
  }

  /**
   * Generate topic distribution and coverage analytics
   */
  private async generateTopicAnalytics(): Promise<any> {
    const allTopicIds = this.layerService.getAllTopicIds();
    const domainDistribution: Record<string, number> = {};
    const difficultyDistribution: Record<string, number> = {};
    const overrideStats = this.layerService.getOverriddenTopics();

    // Analyze a sample of topics for domain/difficulty distribution
    const sampleSize = Math.min(50, allTopicIds.length);
    const sampleTopics = allTopicIds.slice(0, sampleSize);

    for (const topicId of sampleTopics) {
      const resolution = await this.layerService.resolveTopic(topicId);
      if (resolution) {
        const domains = getDomainList(resolution.topic.frontmatter.domain);
        const difficulty = resolution.topic.frontmatter.difficulty;

        // Count each domain the topic belongs to
        for (const domain of domains) {
          domainDistribution[domain] = (domainDistribution[domain] || 0) + 1;
        }
        if (difficulty) {
          difficultyDistribution[difficulty] =
            (difficultyDistribution[difficulty] || 0) + 1;
        }
      }
    }

    return {
      total_topics: allTopicIds.length,
      analyzed_sample: sampleSize,
      domain_distribution: domainDistribution,
      difficulty_distribution: difficultyDistribution,
      override_statistics: {
        total_overrides: Object.keys(overrideStats).length,
        override_percentage:
          allTopicIds.length > 0
            ? (
                (Object.keys(overrideStats).length / allTopicIds.length) *
                100
              ).toFixed(1) + "%"
            : "0%",
      },
      coverage_insights: {
        domains_covered: Object.keys(domainDistribution).length,
        difficulty_levels: Object.keys(difficultyDistribution).length,
        most_common_domain:
          Object.entries(domainDistribution).sort(
            ([, a], [, b]) => b - a,
          )[0]?.[0] || "N/A",
        most_common_difficulty:
          Object.entries(difficultyDistribution).sort(
            ([, a], [, b]) => b - a,
          )[0]?.[0] || "N/A",
      },
    };
  }

  /**
   * Generate layer performance analytics
   */
  private generateLayerPerformanceAnalytics(): any {
    const layerStats = this.layerService.getLayerStatistics();
    const layerMetrics = this.layerService.getStatistics();

    const formattedMetrics = layerMetrics.map((stats) => {
      return {
        name: stats.name,
        priority: stats.priority,
        enabled: stats.enabled,
        topic_count: stats.topicCount,
        index_count: stats.indexCount,
        memory_usage_mb: stats.memoryUsage?.total
          ? (stats.memoryUsage.total / (1024 * 1024)).toFixed(2)
          : "N/A",
        load_time_ms: stats.loadTimeMs || 0,
        type: "MultiContentLayer",
      };
    });

    const totalTopics = layerMetrics.reduce(
      (sum, stats) => sum + stats.topicCount,
      0,
    );

    return {
      system_totals: {
        total_layers: layerMetrics.length,
        total_topics: totalTopics,
        total_indexes: layerMetrics.reduce(
          (sum, stats) => sum + stats.indexCount,
          0,
        ),
        total_memory_mb: "N/A", // Memory tracking not implemented in new system
      },
      layer_metrics: formattedMetrics,
      performance_insights: {
        fastest_layer:
          formattedMetrics.sort((a, b) => a.load_time_ms - b.load_time_ms)[0]
            ?.name || "N/A",
        most_topics:
          formattedMetrics.sort((a, b) => b.topic_count - a.topic_count)[0]
            ?.name || "N/A",
        layer_efficiency:
          layerMetrics.length > 0
            ? (totalTopics / layerMetrics.length).toFixed(1) +
              " topics/layer avg"
            : "N/A",
      },
    };
  }

  /**
   * Generate configuration optimization insights
   */
  private async generateConfigurationInsights(): Promise<any> {
    const validator = new ConfigurationValidator();
    const validation = await validator.validate(this.configuration);

    const insights = {
      configuration_quality: {
        overall_score: validation.score,
        is_valid: validation.valid,
        error_count: validation.errors.length,
        warning_count: validation.warnings.length,
      },
      layer_configuration: {
        total_layers: this.configuration.layers.length,
        enabled_layers: this.configuration.layers.filter((l) => l.enabled)
          .length,
        layer_types: this.configuration.layers.reduce(
          (acc, layer) => {
            acc[layer.source.type] = (acc[layer.source.type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
        priority_distribution: this.configuration.layers
          .map((l) => l.priority)
          .sort((a, b) => a - b),
      },
      optimization_recommendations: [],
    } as any;

    // Generate optimization recommendations
    if (this.configuration.layers.filter((l) => l.enabled).length < 2) {
      insights.optimization_recommendations.push({
        type: "layer_diversity",
        message:
          "Consider adding more layer types (git, local overrides) for better customization",
        impact: "medium",
      });
    }

    if (this.configuration.performance.max_concurrent_loads < 3) {
      insights.optimization_recommendations.push({
        type: "performance",
        message:
          "Increase max_concurrent_loads for better performance on modern systems",
        impact: "low",
      });
    }

    if (!this.configuration.security.validate_sources) {
      insights.optimization_recommendations.push({
        type: "security",
        message: "Enable source validation for better security",
        impact: "high",
      });
    }

    if (validation.warnings.length > 0) {
      insights.optimization_recommendations.push({
        type: "configuration",
        message: `Address ${validation.warnings.length} configuration warnings`,
        impact: "medium",
      });
    }

    return insights;
  }

  /**
   * Auto-initialize the workspace from the BC_INTEL_WORKSPACE_PATH environment
   * variable, when provided by the host (e.g. the VS Code extension).
   *
   * Without this, the only way to set the workspace is for the client to call
   * set_workspace_info with an explicit path. Some clients cannot reliably
   * determine that path and end up passing a placeholder, which fails and loops.
   * Reading the host-provided path here makes initialization deterministic and
   * is a no-op when the variable is absent or points to a missing directory.
   */
  private async autoInitializeWorkspaceFromEnvironment(): Promise<void> {
    const envPath = process.env["BC_INTEL_WORKSPACE_PATH"];
    if (!envPath) {
      return;
    }

    try {
      const { existsSync } = await import("fs");
      if (!existsSync(envPath)) {
        console.error(
          `⚠️ BC_INTEL_WORKSPACE_PATH is set but does not exist: ${envPath}`,
        );
        return;
      }

      console.error(
        `📁 Auto-initializing workspace from BC_INTEL_WORKSPACE_PATH: ${envPath}`,
      );
      const result = await this.setWorkspaceInfo(envPath, this.availableMcps);
      console.error(
        result.success
          ? `✅ ${result.message}`
          : `⚠️ Auto-initialization failed: ${result.message}`,
      );
    } catch (error) {
      console.error(
        "⚠️ Failed to auto-initialize workspace from environment:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async run(): Promise<void> {
    try {
      // Ultra-early diagnostics for platform issues
      console.error(
        "=== BC Code Intelligence MCP Server Startup Diagnostics ===",
      );
      console.error(`Platform: ${process.platform}`);
      console.error(`Node version: ${process.version}`);
      console.error(`Architecture: ${process.arch}`);
      console.error(`Working directory: ${process.cwd()}`);
      console.error(`Script path: ${process.argv[1]}`);

      const version = this.getPackageVersion();
      console.error(
        `🚀 BC Code Intelligence MCP Server v${version} starting...`,
      );

      // CRITICAL FIX for Issue #31: Connect transport BEFORE heavy initialization
      // This allows the MCP handshake to complete quickly, preventing timeouts
      console.error("🔌 Connecting MCP transport (fast handshake)...");
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("✅ MCP transport connected - handshake complete");

      // DO NOT initialize services here - initialization happens lazily:
      // 1. If client calls set_workspace_info, that triggers initialization
      // 2. If client calls a tool directly, the tool waits and triggers initialization
      console.error("💡 Server ready. Services will initialize on first request or set_workspace_info call.");

      // If the host (e.g. the VS Code extension) provided a workspace path via
      // the BC_INTEL_WORKSPACE_PATH environment variable, initialize from it now.
      // This breaks the chicken-and-egg loop where a client calls get_workspace_info
      // (empty) and then guesses a placeholder path for set_workspace_info.
      await this.autoInitializeWorkspaceFromEnvironment();

      // Server is ready to accept requests immediately
      // Tools will trigger initialization on first use if needed
    } catch (error) {
      console.error("💥 Fatal error during server startup:", error);
      console.error(
        "Error stack:",
        error instanceof Error ? error.stack : "No stack trace",
      );
      process.exit(1);
    }
  }

  /**
   * Perform heavy initialization in background after MCP handshake
   */
  private async performBackgroundInitialization(): Promise<void> {
    try {
      // Verify embedded knowledge path BEFORE any service initialization
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const embeddedPath = join(__dirname, "..", "embedded-knowledge");
      console.error(`Embedded knowledge path: ${embeddedPath}`);
      console.error(`Embedded knowledge exists: ${existsSync(embeddedPath)}`);

      if (existsSync(embeddedPath)) {
        const expectedDirs = ["domains", "specialists", "workflows"];
        for (const dir of expectedDirs) {
          const dirPath = join(embeddedPath, dir);
          console.error(`  ${dir}/: ${existsSync(dirPath)}`);
        }
      }

      // Try to load user-level configuration first (company layers)
      // If no user config exists, fall back to embedded-only mode
      console.error(
        "📦 Checking for user-level configuration (company layers)...",
      );

      try {
        const userConfigResult = await this.configLoader.loadConfiguration();

        if (
          userConfigResult.config.layers &&
          userConfigResult.config.layers.length > 1
        ) {
          // User has configured layers (embedded + company/git layers)
          console.error(
            `✅ Found user-level configuration with ${userConfigResult.config.layers.length} layers`,
          );
          this.configuration = userConfigResult.config;

          try {
            await this.initializeWithConfiguration(userConfigResult);
          } catch (configError) {
            // CRITICAL FIX: If user config initialization fails (e.g. git layer auth failure),
            // fall back to embedded-only mode instead of crashing the server
            console.error(
              "❌ Failed to initialize with user configuration:",
              configError instanceof Error
                ? configError.message
                : String(configError),
            );
            console.error("🔄 Falling back to embedded-only mode...");
            await this.initializeEmbeddedOnly();
          }
        } else {
          // No user config or only embedded layer - use embedded-only mode
          console.error(
            "📦 No user-level configuration found, loading embedded knowledge only...",
          );
          await this.initializeEmbeddedOnly();
        }
      } catch (error) {
        console.error(
          "⚠️  Failed to load user configuration, falling back to embedded-only:",
          error instanceof Error ? error.message : String(error),
        );
        await this.initializeEmbeddedOnly();
      }

      console.error(
        `✅ BC Code Intelligence MCP Server v${this.getPackageVersion()} started successfully`,
      );
      console.error(
        `💡 To enable project-specific layers, call set_workspace_info with your project path`,
      );
    } catch (error) {
      console.error("❌ Initialization error:", error);
      throw error;
    }
  }

  /**
   * Initialize only embedded knowledge layer at startup
   */
  private async initializeEmbeddedOnly(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const embeddedPath = join(__dirname, "../embedded-knowledge");

    // Initialize minimal layer service with only embedded
    this.layerService = new MultiContentLayerService();

    const { EmbeddedKnowledgeLayer } = await import(
      "./layers/embedded-layer.js"
    );
    const embeddedLayer = new EmbeddedKnowledgeLayer(embeddedPath);

    this.layerService.addLayer(embeddedLayer as any);
    await this.layerService.initialize();

    // Initialize minimal services for embedded-only mode
    const legacyConfig: BCKBConfig = {
      knowledge_base_path: embeddedPath,
      indexes_path: join(embeddedPath, "indexes"),
      workflows_path: join(embeddedPath, "workflows"),
      cache_size: 1000,
      max_search_results: 20,
      default_bc_version: "BC22",
      enable_fuzzy_search: true,
      search_threshold: 0.6,
    };

    this.knowledgeService = new KnowledgeService(legacyConfig);
    await this.knowledgeService.initialize();

    this.codeAnalysisService = new CodeAnalysisService(this.knowledgeService);
    this.methodologyService = new MethodologyService(this.knowledgeService);

    const specialistDiscoveryService = new SpecialistDiscoveryService(
      this.layerService,
    );
    this.workflowService = new WorkflowService(
      this.knowledgeService,
      this.methodologyService,
      specialistDiscoveryService,
    );

    // Initialize tool classes (but servicesInitialized = false will intercept them)
    // We need these initialized so they appear in the tool list, but they won't execute
    const sessionStorageConfig = this.layerService.getSessionStorageConfig();
    this.specialistSessionManager = new SpecialistSessionManager(
      this.layerService,
      sessionStorageConfig,
    );
    this.specialistDiscoveryService = new SpecialistDiscoveryService(
      this.layerService,
    );

    // Note: Services and tools are initialized - mark as ready
    this.servicesInitialized = true;
    console.error(
      "✅ Embedded knowledge loaded and ready for queries.",
    );
  }

  /**
   * Initialize with user-level configuration (company layers from ~/.bc-code-intel/config.yaml)
   */
  private async initializeWithConfiguration(
    configResult: ConfigurationLoadResult,
  ): Promise<void> {
    console.error(`🚀 Initializing with user-level configuration...`);

    this.configuration = configResult.config; // Initialize services with the loaded configuration
    await this.initializeServices(configResult);

    this.servicesInitialized = true;

    const specialists = await this.layerService.getAllSpecialists();
    const topics = this.layerService.getAllTopicIds();
    const layers = this.layerService.getLayers();

    console.error(
      `✅ User configuration loaded: ${topics.length} topics from ${layers.length} layers, ${specialists.length} specialists`,
    );
    layers.forEach((layer) => {
      const topicCount = layer.getTopicIds().length;
      console.error(
        `   📚 ${layer.name}: ${topicCount} topics (priority ${layer.priority})`,
      );
    });
  }

  /**
   * Set workspace root and MCP ecosystem info, initialize full services
   */
  private async setWorkspaceInfo(
    path: string,
    availableMcps: string[] = [],
  ): Promise<{ success: boolean; message: string; reloaded: boolean }> {
    try {
      // Cancel any in-progress initialization - we're doing a fresh one now
      if (this.initializationPromise) {
        console.error("⚠️ Cancelling stale initialization...");
        this.initializationPromise = null;
      }

      // Normalize and validate path
      const { resolve } = await import("path");
      const { existsSync } = await import("fs");
      const resolvedPath = resolve(path);

      if (!existsSync(resolvedPath)) {
        return {
          success: false,
          message: `Path does not exist: ${resolvedPath}`,
          reloaded: false,
        };
      }

      // Check if this is the same workspace
      if (this.workspaceRoot === resolvedPath) {
        // Update availableMcps even if workspace unchanged
        this.availableMcps = availableMcps;

        // Update layer service with new MCP availability (dynamic filtering)
        if (this.layerService) {
          this.layerService.setAvailableMcps(availableMcps);
        }

        return {
          success: true,
          message: `Workspace root already set to: ${resolvedPath}${availableMcps.length > 0 ? ` | Updated MCP ecosystem: ${availableMcps.length} servers` : ""}`,
          reloaded: false,
        };
      }

      console.error(`📁 Setting workspace root to: ${resolvedPath}`);
      if (availableMcps.length > 0) {
        console.error(`🔧 MCP Ecosystem: ${availableMcps.join(", ")}`);
      }

      // Change working directory
      process.chdir(resolvedPath);
      this.workspaceRoot = resolvedPath;
      this.availableMcps = availableMcps;

      // Update layer service with available MCPs for conditional topic filtering
      if (this.layerService) {
        this.layerService.setAvailableMcps(availableMcps);
      }

      // Load configuration with workspace context (merges user + project configs)
      const configResult =
        await this.configLoader.loadConfiguration(resolvedPath);

      if (configResult.validation_errors.length > 0) {
        console.error("⚠️  Configuration validation errors:");
        configResult.validation_errors.forEach((error) => {
          console.error(`   - ${error.field}: ${error.message}`);
        });
      }

      // Initialize full services with configuration
      await this.initializeServices(configResult);
      this.servicesInitialized = true;

      const specialists = await this.layerService.getAllSpecialists();
      const topics = this.layerService.getAllTopicIds();

      const mcpInfo =
        availableMcps.length > 0
          ? ` | MCP Ecosystem: ${availableMcps.length} servers`
          : "";

      return {
        success: true,
        message: `Workspace configured successfully. Loaded ${topics.length} topics from ${this.layerService.getLayers().length} layers, ${specialists.length} specialists available.${mcpInfo}`,
        reloaded: true,
      };
    } catch (error) {
      console.error("❌ Error setting workspace info:", error);
      return {
        success: false,
        message: `Failed to set workspace info: ${error instanceof Error ? error.message : String(error)}`,
        reloaded: false,
      };
    }
  }

  /**
   * Get current workspace info
   */
  private getWorkspaceInfo(): {
    workspace_root: string | null;
    available_mcps: string[];
  } {
    return {
      workspace_root: this.workspaceRoot,
      available_mcps: this.availableMcps,
    };
  }

  /**
   * Get configuration quality score for startup diagnostics
   */
  private async getConfigurationQuality(): Promise<number> {
    if (!this.configuration) return 0;

    try {
      const validator = new ConfigurationValidator();
      const validation = await validator.validate(this.configuration);
      return validation.score;
    } catch {
      return 0;
    }
  }
}

// Start the server
async function main() {
  try {
    // Ultra-early platform diagnostics (before any server initialization)
    console.error("=== Pre-Initialization Platform Check ===");
    console.error(`Node.js: ${process.version}`);
    console.error(`Platform: ${process.platform} (${process.arch})`);
    console.error(`PWD: ${process.cwd()}`);
    console.error(`Script: ${process.argv[1]}`);

    // Check for workspace root argument (e.g., "." passed from MCP client)
    const workspaceArg = process.argv[2];
    if (workspaceArg) {
      console.error(`Workspace argument provided: "${workspaceArg}"`);
      const { resolve } = await import("path");
      const resolvedPath = resolve(workspaceArg);
      console.error(`Resolved to: ${resolvedPath}`);

      // Override process.cwd() for config/layer discovery
      process.chdir(resolvedPath);
      console.error(`Changed working directory to: ${process.cwd()}`);
    }

    const server = new BCCodeIntelligenceServer();
    await server.run();
  } catch (error) {
    console.error("💥 Fatal error in main():", error);
    console.error("Error details:", {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : "No stack trace",
    });
    process.exit(1);
  }
}

// Handle process termination
process.on("SIGINT", async () => {
  console.error("BC Code Intelligence MCP Server shutting down (SIGINT)...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("BC Code Intelligence MCP Server shutting down (SIGTERM)...");
  process.exit(0);
});

// Catch unhandled promise rejections (common cause of silent crashes)
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Promise Rejection:");
  console.error("Reason:", reason);
  console.error("Promise:", promise);
  if (reason instanceof Error) {
    console.error("Stack:", reason.stack);
  }
  // Don't exit in test environment - let test framework handle it
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
});

// Catch uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught Exception:");
  console.error("Error:", error);
  console.error("Stack:", error.stack);
  // Don't exit in test environment - let test framework handle it
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
});

// Run server if this is the main module
// Check both direct execution (index.js) and binary execution (bc-code-intelligence-mcp, bc-code-intel-server)
if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("bc-code-intelligence-mcp") ||
  process.argv[1]?.endsWith("bc-code-intel-server")
) {
  main().catch((error) => {
    console.error("Fatal error in BC Code Intelligence MCP Server:", error);
    process.exit(1);
  });
}

export { BCCodeIntelligenceServer };
