/**
 * Configuration Validator
 *
 * Comprehensive validation for BCKB configuration with detailed error messages,
 * source accessibility checking, and security validation.
 */

import { access, stat, constants } from 'fs/promises';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

import {
  BCCodeIntelConfiguration,
  LayerConfiguration,
  LayerSourceType,
  AuthType,
  ValidationError,
  ConfigurationWarning
} from '../types/index.js';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ConfigurationWarning[];
  score: number; // 0-100, configuration quality score
}

export class ConfigurationValidator {

  /**
   * Validate complete BCKB configuration
   */
  async validate(config: BCCodeIntelConfiguration): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ConfigurationWarning[] = [];

    console.error('🔍 Validating BCKB configuration...');

    // 1. Basic structure validation
    this.validateBasicStructure(config, errors);

    // 2. Layer validation
    await this.validateLayers(config.layers, errors, warnings);

    // 3. Performance settings validation
    this.validatePerformanceSettings(config, errors, warnings);

    // 4. Security settings validation
    this.validateSecuritySettings(config, errors, warnings);

    // 5. Cache settings validation
    this.validateCacheSettings(config, errors, warnings);

    // 6. Check for potential conflicts
    this.checkLayerConflicts(config.layers, errors, warnings);

    // 7. Generate quality score
    const score = this.calculateQualityScore(config, errors.length, warnings.length);

    const result: ValidationResult = {
      valid: errors.length === 0,
      errors,
      warnings,
      score
    };

    console.error(`${result.valid ? '✅' : '❌'} Configuration validation complete`);
    console.error(`   Errors: ${errors.length}, Warnings: ${warnings.length}, Score: ${score}/100`);

    return result;
  }

  /**
   * Validate basic configuration structure
   */
  private validateBasicStructure(config: BCCodeIntelConfiguration, errors: ValidationError[]): void {
    if (!config.layers || !Array.isArray(config.layers)) {
      errors.push({
        field: 'layers',
        message: 'Configuration must have a layers array'
      });
      return;
    }

    if (config.layers.length === 0) {
      errors.push({
        field: 'layers',
        message: 'At least one layer must be configured'
      });
    }

    // Check for required embedded layer
    const hasEmbeddedLayer = config.layers.some(layer =>
      layer.source.type === LayerSourceType.EMBEDDED
    );

    if (!hasEmbeddedLayer) {
      errors.push({
        field: 'layers',
        message: 'Configuration must include at least one embedded layer',
        suggestion: 'Add an embedded layer as the base knowledge source'
      });
    }
  }

  /**
   * Validate all layers configuration
   */
  private async validateLayers(
    layers: LayerConfiguration[],
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): Promise<void> {
    const layerNames = new Set<string>();
    const layerPriorities = new Set<number>();

    for (const [index, layer] of layers.entries()) {
      const fieldPrefix = `layers[${index}]`;

      // Validate layer name uniqueness
      if (layerNames.has(layer.name)) {
        errors.push({
          field: `${fieldPrefix}.name`,
          message: `Duplicate layer name: ${layer.name}`,
          value: layer.name
        });
      }
      layerNames.add(layer.name);

      // Check for priority conflicts
      if (layerPriorities.has(layer.priority)) {
        warnings.push({
          type: 'invalid_value',
          message: `Multiple layers have priority ${layer.priority}`,
          suggestion: 'Use unique priorities to ensure predictable layer ordering'
        });
      }
      layerPriorities.add(layer.priority);

      // Validate layer name format
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(layer.name)) {
        errors.push({
          field: `${fieldPrefix}.name`,
          message: 'Layer name must start with letter and contain only letters, numbers, underscores, and hyphens',
          value: layer.name
        });
      }

      // Validate priority range
      if (layer.priority < 0 || layer.priority > 1000) {
        errors.push({
          field: `${fieldPrefix}.priority`,
          message: 'Layer priority must be between 0 and 1000',
          value: layer.priority
        });
      }

      // Validate source configuration
      await this.validateLayerSource(layer, `${fieldPrefix}.source`, errors, warnings);

      // Validate authentication
      if (layer.auth) {
        this.validateAuthentication(layer.auth, `${fieldPrefix}.auth`, errors, warnings);
      }

      // Validate cache duration format
      if (layer.cache_duration) {
        this.validateCacheDuration(layer.cache_duration, `${fieldPrefix}.cache_duration`, errors);
      }

      // Validate patterns
      if (layer.patterns) {
        this.validatePatterns(layer.patterns, `${fieldPrefix}.patterns`, warnings);
      }
    }
  }

  /**
   * Validate layer source configuration
   */
  private async validateLayerSource(
    layer: LayerConfiguration,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): Promise<void> {
    const source = layer.source;

    if (!source.type) {
      errors.push({
        field: `${fieldPrefix}.type`,
        message: 'Layer source type is required'
      });
      return;
    }

    switch (source.type) {
      case LayerSourceType.GIT:
        await this.validateGitSource(source, fieldPrefix, errors, warnings);
        break;

      case LayerSourceType.LOCAL:
        await this.validateLocalSource(source, fieldPrefix, errors, warnings);
        break;

      case LayerSourceType.EMBEDDED:
        await this.validateEmbeddedSource(source, fieldPrefix, errors, warnings);
        break;

      case LayerSourceType.HTTP:
        this.validateHttpSource(source, fieldPrefix, errors, warnings);
        break;

      case LayerSourceType.NPM:
        this.validateNpmSource(source, fieldPrefix, errors, warnings);
        break;

      default:
        errors.push({
          field: `${fieldPrefix}.type`,
          message: `Unsupported layer source type: ${source.type}`,
          value: source.type
        });
    }
  }

  /**
   * Validate Git source configuration
   */
  private async validateGitSource(
    source: any,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): Promise<void> {
    if (!source.url) {
      errors.push({
        field: `${fieldPrefix}.url`,
        message: 'Git source requires URL'
      });
      return;
    }

    // Validate URL format
    try {
      const url = new URL(source.url);

      // Check for common Git hosting platforms
      const hostname = url.hostname.toLowerCase();
      if (!['github.com', 'gitlab.com', 'bitbucket.org'].includes(hostname) &&
          !hostname.includes('gitlab') && !hostname.includes('git')) {
        warnings.push({
          type: 'invalid_value',
          message: `Unusual git hostname: ${hostname}`,
          suggestion: 'Ensure this is a valid git repository host'
        });
      }

      // Warn about HTTP instead of HTTPS
      if (url.protocol === 'http:') {
        warnings.push({
          type: 'security',
          message: 'Git URL uses HTTP instead of HTTPS',
          suggestion: 'Use HTTPS for better security'
        });
      }

    } catch (error) {
      errors.push({
        field: `${fieldPrefix}.url`,
        message: 'Invalid URL format',
        value: source.url
      });
    }

    // Validate branch name if provided
    if (source.branch && !/^[a-zA-Z0-9/_.-]+$/.test(source.branch)) {
      warnings.push({
        type: 'invalid_value',
        message: `Unusual branch name: ${source.branch}`,
        suggestion: 'Ensure branch name exists in the repository'
      });
    }

    // Validate subpath if provided
    if (source.subpath) {
      if (source.subpath.startsWith('/') || source.subpath.includes('..')) {
        warnings.push({
          type: 'security',
          message: `Potentially unsafe subpath: ${source.subpath}`,
          suggestion: 'Use relative paths without .. navigation'
        });
      }
    }
  }

  /**
   * Validate local source configuration
   */
  private async validateLocalSource(
    source: any,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): Promise<void> {
    if (!source.path) {
      errors.push({
        field: `${fieldPrefix}.path`,
        message: 'Local source requires path'
      });
      return;
    }

    // Resolve path
    let resolvedPath: string;
    try {
      resolvedPath = source.path.startsWith('~')
        ? source.path.replace('~', homedir())
        : resolve(source.path);
    } catch (error) {
      errors.push({
        field: `${fieldPrefix}.path`,
        message: 'Invalid path format',
        value: source.path
      });
      return;
    }

    // Check if path exists and is accessible
    try {
      await access(resolvedPath, constants.R_OK);
      const stats = await stat(resolvedPath);

      if (!stats.isDirectory()) {
        errors.push({
          field: `${fieldPrefix}.path`,
          message: 'Local source path must be a directory',
          value: source.path
        });
      }

    } catch (error) {
      warnings.push({
        type: 'invalid_value',
        message: `Local path not accessible: ${source.path}`,
        suggestion: 'Ensure directory exists and is readable'
      });
    }
  }

  /**
   * Validate embedded source configuration
   */
  private async validateEmbeddedSource(
    source: any,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): Promise<void> {
    // ES module: __dirname equivalent
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const embeddedPath = source.path || join(__dirname, '../embedded-knowledge');

    try {
      await access(embeddedPath, constants.R_OK);
      const stats = await stat(embeddedPath);

      if (!stats.isDirectory()) {
        errors.push({
          field: `${fieldPrefix}.path`,
          message: 'Embedded source path must be a directory',
          value: embeddedPath
        });
      }

    } catch (error) {
      errors.push({
        field: `${fieldPrefix}.path`,
        message: `Embedded knowledge directory not found: ${embeddedPath}`,
        suggestion: 'Ensure embedded knowledge is available'
      });
    }
  }

  /**
   * Validate HTTP source configuration
   */
  private validateHttpSource(
    source: any,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): Promise<void> {
    if (!source.url) {
      errors.push({
        field: `${fieldPrefix}.url`,
        message: 'HTTP source requires URL'
      });
      return Promise.resolve();
    }

    try {
      const url = new URL(source.url);

      if (url.protocol !== 'https:') {
        warnings.push({
          type: 'security',
          message: 'HTTP source should use HTTPS',
          suggestion: 'Use HTTPS for secure content delivery'
        });
      }

    } catch (error) {
      errors.push({
        field: `${fieldPrefix}.url`,
        message: 'Invalid HTTP URL format',
        value: source.url
      });
    }

    // Note: HTTP layers are not implemented yet
    warnings.push({
      type: 'deprecated',
      message: 'HTTP layers are not yet implemented',
      suggestion: 'Use git or local layers instead'
    });

    return Promise.resolve();
  }

  /**
   * Validate NPM source configuration
   */
  private validateNpmSource(
    source: any,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): void {
    if (!source.package) {
      errors.push({
        field: `${fieldPrefix}.package`,
        message: 'NPM source requires package name'
      });
      return;
    }

    // Validate NPM package name format
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(source.package)) {
      errors.push({
        field: `${fieldPrefix}.package`,
        message: 'Invalid NPM package name format',
        value: source.package
      });
    }

    // Note: NPM layers are not implemented yet
    warnings.push({
      type: 'deprecated',
      message: 'NPM layers are not yet implemented',
      suggestion: 'Use git or local layers instead'
    });
  }

  /**
   * Validate authentication configuration
   */
  private validateAuthentication(
    auth: any,
    fieldPrefix: string,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): void {
    if (!auth.type) {
      errors.push({
        field: `${fieldPrefix}.type`,
        message: 'Authentication type is required'
      });
      return;
    }

    switch (auth.type) {
      case AuthType.TOKEN:
        if (auth.token && !auth.token.startsWith('$')) {
          warnings.push({
            type: 'security',
            message: 'Token appears to be hardcoded',
            suggestion: 'Use environment variable (token_env_var) instead'
          });
        }

        if (!auth.token && !auth.token_env_var) {
          errors.push({
            field: `${fieldPrefix}`,
            message: 'Token authentication requires either token or token_env_var'
          });
        }
        break;

      case AuthType.SSH_KEY:
        if (auth.key_path && !auth.key_path.includes('~') && !auth.key_path.startsWith('/')) {
          warnings.push({
            type: 'invalid_value',
            message: 'SSH key path should be absolute or use ~ notation',
            suggestion: 'Use ~/.ssh/id_rsa format'
          });
        }
        break;

      case AuthType.BASIC:
        if (!auth.username) {
          errors.push({
            field: `${fieldPrefix}.username`,
            message: 'Basic authentication requires username'
          });
        }

        if (auth.password && !auth.password.startsWith('$')) {
          warnings.push({
            type: 'security',
            message: 'Password appears to be hardcoded',
            suggestion: 'Use environment variable (password_env_var) instead'
          });
        }

        if (!auth.password && !auth.password_env_var) {
          errors.push({
            field: `${fieldPrefix}`,
            message: 'Basic authentication requires either password or password_env_var'
          });
        }
        break;

      case AuthType.OAUTH:
        warnings.push({
          type: 'deprecated',
          message: 'OAuth authentication is not yet fully implemented',
          suggestion: 'Use token or SSH key authentication instead'
        });
        break;

      default:
        errors.push({
          field: `${fieldPrefix}.type`,
          message: `Unsupported authentication type: ${auth.type}`,
          value: auth.type
        });
    }
  }

  /**
   * Validate cache duration format
   */
  private validateCacheDuration(
    duration: string,
    fieldPrefix: string,
    errors: ValidationError[]
  ): void {
    const validPattern = /^((\d+)(ms|s|m|h|d|w)|permanent|immediate)$/;

    if (!validPattern.test(duration)) {
      errors.push({
        field: fieldPrefix,
        message: 'Invalid cache duration format',
        value: duration,
        suggestion: 'Use format like "1h", "30m", "permanent", or "immediate"'
      });
    }
  }

  /**
   * Validate file patterns
   */
  private validatePatterns(
    patterns: string[],
    fieldPrefix: string,
    warnings: ConfigurationWarning[]
  ): void {
    for (const pattern of patterns) {
      // Check for potentially problematic patterns
      if (pattern.includes('**/**/**')) {
        warnings.push({
          type: 'invalid_value',
          message: `Potentially inefficient pattern: ${pattern}`,
          suggestion: 'Simplify glob patterns for better performance'
        });
      }

      if (pattern.startsWith('/') || pattern.includes('../')) {
        warnings.push({
          type: 'security',
          message: `Potentially unsafe pattern: ${pattern}`,
          suggestion: 'Use relative patterns within the layer'
        });
      }
    }
  }

  /**
   * Validate performance settings
   */
  private validatePerformanceSettings(
    config: BCCodeIntelConfiguration,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): void {
    const perf = config.performance;

    if (perf.max_concurrent_loads > 20) {
      warnings.push({
        type: 'invalid_value',
        message: 'High concurrent load limit may cause resource exhaustion',
        suggestion: 'Consider reducing performance.max_concurrent_loads'
      });
    }

    if (perf.load_timeout_ms < 5000) {
      warnings.push({
        type: 'invalid_value',
        message: 'Very short load timeout may cause failures',
        suggestion: 'Consider increasing performance.load_timeout_ms'
      });
    }

    if (perf.memory_limit_mb < 100) {
      warnings.push({
        type: 'invalid_value',
        message: 'Low memory limit may impact functionality',
        suggestion: 'Consider increasing performance.memory_limit_mb'
      });
    }

    if (perf.max_layers > 50) {
      warnings.push({
        type: 'invalid_value',
        message: 'Very high layer limit may impact performance',
        suggestion: 'Consider reducing performance.max_layers'
      });
    }
  }

  /**
   * Validate security settings
   */
  private validateSecuritySettings(
    config: BCCodeIntelConfiguration,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): void {
    const security = config.security;

    if (security.allow_http_sources && security.trusted_domains.length === 0) {
      warnings.push({
        type: 'security',
        message: 'HTTP sources allowed without trusted domains',
        suggestion: 'Specify trusted_domains when allowing HTTP sources'
      });
    }

    if (!security.validate_sources) {
      warnings.push({
        type: 'security',
        message: 'Source validation is disabled',
        suggestion: 'Enable validate_sources for better security'
      });
    }

    if (security.max_download_size_mb > 500) {
      warnings.push({
        type: 'security',
        message: 'High download size limit may be risky',
        suggestion: 'Consider reducing max_download_size_mb'
      });
    }
  }

  /**
   * Validate cache settings
   */
  private validateCacheSettings(
    config: BCCodeIntelConfiguration,
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): void {
    const cache = config.cache;

    if (cache.max_size_mb < 10) {
      warnings.push({
        type: 'invalid_value',
        message: 'Very low cache size may impact performance',
        suggestion: 'Consider increasing cache.max_size_mb'
      });
    }

    // Validate TTL formats
    for (const [type, ttl] of Object.entries(cache.ttl)) {
      this.validateCacheDuration(ttl, `cache.ttl.${type}`, errors);
    }
  }

  /**
   * Check for layer configuration conflicts
   */
  private checkLayerConflicts(
    layers: LayerConfiguration[],
    errors: ValidationError[],
    warnings: ConfigurationWarning[]
  ): void {
    // Check for conflicting git URLs
    const gitUrls = new Set<string>();
    const gitLayers = layers.filter(layer => layer.source.type === LayerSourceType.GIT);

    for (const layer of gitLayers) {
      const source = layer.source as any;
      if (source.url) {
        if (gitUrls.has(source.url)) {
          warnings.push({
            type: 'invalid_value',
            message: `Multiple layers use same git URL: ${source.url}`,
            suggestion: 'Use different subpaths or branches to differentiate layers'
          });
        }
        gitUrls.add(source.url);
      }
    }

    // Check for conflicting local paths
    const localPaths = new Set<string>();
    const localLayers = layers.filter(layer => layer.source.type === LayerSourceType.LOCAL);

    for (const layer of localLayers) {
      const source = layer.source as any;
      if (source.path) {
        const resolvedPath = resolve(source.path);
        if (localPaths.has(resolvedPath)) {
          warnings.push({
            type: 'invalid_value',
            message: `Multiple layers use same local path: ${source.path}`,
            suggestion: 'Use different paths for each local layer'
          });
        }
        localPaths.add(resolvedPath);
      }
    }
  }

  /**
   * Calculate configuration quality score
   */
  private calculateQualityScore(
    config: BCCodeIntelConfiguration,
    errorCount: number,
    warningCount: number
  ): number {
    let score = 100;

    // Deduct points for errors (major issues)
    score -= errorCount * 20;

    // Deduct points for warnings (minor issues)
    score -= warningCount * 5;

    // Bonus points for good practices
    const hasGitLayer = config.layers.some(l => l.source.type === LayerSourceType.GIT);
    const hasLocalLayer = config.layers.some(l => l.source.type === LayerSourceType.LOCAL);
    const hasCacheConfig = config.cache.strategy !== 'none';
    const hasSecurityValidation = config.security.validate_sources;

    if (hasGitLayer) score += 5; // Using git layers
    if (hasLocalLayer) score += 5; // Using local overrides
    if (hasCacheConfig) score += 5; // Has caching enabled
    if (hasSecurityValidation) score += 5; // Has security validation

    return Math.max(0, Math.min(100, score));
  }
}
