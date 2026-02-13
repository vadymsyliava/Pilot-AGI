/**
 * Registry Auto-Discovery Scanner — Phase 8.5 (Pilot AGI-wu4r)
 *
 * Scans existing codebase to build project registry automatically.
 * Detects framework type and scans accordingly.
 *
 * Supported frameworks:
 * - Pages: Next.js (app/, pages/), React Router, file-based routing
 * - Components: React/Vue/Svelte component directories
 * - APIs: Express/Fastify/Hono route handlers, Next.js API routes
 * - Database: Prisma, Drizzle, Mongoose schemas, SQL migrations
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// FRAMEWORK DETECTION
// =============================================================================

/**
 * Detect project framework and technology stack.
 *
 * @param {string} projectRoot
 * @returns {{ framework, language, hasPages, hasAPI, hasDB, details }}
 */
function detectFramework(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const result = {
    framework: null,
    language: 'javascript',
    hasPages: false,
    hasAPI: false,
    hasDB: false,
    details: {}
  };

  // Check package.json for framework detection
  const pkgPath = path.join(projectRoot, 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {}
  }

  const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};

  // TypeScript
  if (allDeps.typescript || fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
    result.language = 'typescript';
  }

  // Next.js
  if (allDeps.next) {
    result.framework = 'nextjs';
    result.hasPages = true;
    result.hasAPI = true;
    result.details.nextVersion = allDeps.next;
    result.details.appRouter = fs.existsSync(path.join(projectRoot, 'app')) ||
                               fs.existsSync(path.join(projectRoot, 'src/app'));
  }
  // Remix
  else if (allDeps['@remix-run/react'] || allDeps['@remix-run/node']) {
    result.framework = 'remix';
    result.hasPages = true;
    result.hasAPI = true;
  }
  // Nuxt
  else if (allDeps.nuxt) {
    result.framework = 'nuxt';
    result.hasPages = true;
    result.hasAPI = true;
  }
  // SvelteKit
  else if (allDeps['@sveltejs/kit']) {
    result.framework = 'sveltekit';
    result.hasPages = true;
    result.hasAPI = true;
  }
  // React (CRA / Vite)
  else if (allDeps.react) {
    result.framework = 'react';
    result.hasPages = !!allDeps['react-router-dom'] || !!allDeps['react-router'];
  }
  // Vue
  else if (allDeps.vue) {
    result.framework = 'vue';
    result.hasPages = !!allDeps['vue-router'];
  }
  // Express
  else if (allDeps.express) {
    result.framework = 'express';
    result.hasAPI = true;
  }
  // Fastify
  else if (allDeps.fastify) {
    result.framework = 'fastify';
    result.hasAPI = true;
  }
  // Hono
  else if (allDeps.hono) {
    result.framework = 'hono';
    result.hasAPI = true;
  }

  // Database detection
  if (allDeps['@prisma/client'] || allDeps.prisma ||
      fs.existsSync(path.join(projectRoot, 'prisma'))) {
    result.hasDB = true;
    result.details.orm = 'prisma';
  } else if (allDeps.drizzle || allDeps['drizzle-orm']) {
    result.hasDB = true;
    result.details.orm = 'drizzle';
  } else if (allDeps.mongoose) {
    result.hasDB = true;
    result.details.orm = 'mongoose';
  } else if (allDeps.knex || allDeps.sequelize || allDeps.typeorm) {
    result.hasDB = true;
    result.details.orm = allDeps.knex ? 'knex' : allDeps.sequelize ? 'sequelize' : 'typeorm';
  }

  return result;
}

// =============================================================================
// SCANNERS
// =============================================================================

/**
 * Scan for pages/routes.
 */
function scanPages(projectRoot, framework) {
  projectRoot = projectRoot || process.cwd();
  const pages = [];

  const pageDirs = getPageDirs(projectRoot, framework);

  for (const dir of pageDirs) {
    if (!fs.existsSync(dir)) continue;
    scanDir(dir, projectRoot, (filePath, relPath) => {
      if (isPageFile(filePath, framework)) {
        pages.push({
          name: pageNameFromPath(relPath, framework),
          file_path: relPath,
          type: 'page',
          description: 'Route: ' + routeFromPath(relPath, framework)
        });
      }
    });
  }

  return pages;
}

/**
 * Scan for components.
 */
function scanComponents(projectRoot, framework) {
  projectRoot = projectRoot || process.cwd();
  const components = [];

  const compDirs = getComponentDirs(projectRoot);

  for (const dir of compDirs) {
    if (!fs.existsSync(dir)) continue;
    scanDir(dir, projectRoot, (filePath, relPath) => {
      if (isComponentFile(filePath)) {
        components.push({
          name: componentNameFromPath(relPath),
          file_path: relPath,
          type: 'component'
        });
      }
    });
  }

  return components;
}

/**
 * Scan for API endpoints.
 */
function scanAPIs(projectRoot, framework) {
  projectRoot = projectRoot || process.cwd();
  const apis = [];

  const apiDirs = getAPIDirs(projectRoot, framework);

  for (const dir of apiDirs) {
    if (!fs.existsSync(dir)) continue;
    scanDir(dir, projectRoot, (filePath, relPath) => {
      if (isAPIFile(filePath, framework)) {
        apis.push({
          name: apiNameFromPath(relPath, framework),
          file_path: relPath,
          type: 'api_route'
        });
      }
    });
  }

  // For Express/Fastify: scan route files
  if (['express', 'fastify', 'hono'].includes(framework)) {
    const routeDirs = [
      path.join(projectRoot, 'src/routes'),
      path.join(projectRoot, 'routes'),
      path.join(projectRoot, 'src/api')
    ];
    for (const dir of routeDirs) {
      if (!fs.existsSync(dir)) continue;
      scanDir(dir, projectRoot, (filePath, relPath) => {
        if (/\.(js|ts|mjs)$/.test(filePath) && !filePath.includes('.test.') && !filePath.includes('.spec.')) {
          apis.push({
            name: apiNameFromPath(relPath, framework),
            file_path: relPath,
            type: 'route_handler'
          });
        }
      });
    }
  }

  return apis;
}

/**
 * Scan for database collections/tables.
 */
function scanDatabase(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const collections = [];

  // Prisma
  const prismaSchema = path.join(projectRoot, 'prisma/schema.prisma');
  if (fs.existsSync(prismaSchema)) {
    const content = fs.readFileSync(prismaSchema, 'utf8');
    const modelRegex = /model\s+(\w+)\s*\{/g;
    let match;
    while ((match = modelRegex.exec(content)) !== null) {
      collections.push({
        name: match[1],
        file_path: 'prisma/schema.prisma',
        type: 'prisma_model',
        description: 'Prisma model: ' + match[1]
      });
    }
  }

  // Drizzle
  const drizzleDirs = [
    path.join(projectRoot, 'src/db/schema'),
    path.join(projectRoot, 'src/schema'),
    path.join(projectRoot, 'db/schema')
  ];
  for (const dir of drizzleDirs) {
    if (!fs.existsSync(dir)) continue;
    scanDir(dir, projectRoot, (filePath, relPath) => {
      if (/\.(js|ts)$/.test(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const tableRegex = /(?:pgTable|sqliteTable|mysqlTable)\s*\(\s*['"](\w+)['"]/g;
        let m;
        while ((m = tableRegex.exec(content)) !== null) {
          collections.push({
            name: m[1],
            file_path: relPath,
            type: 'drizzle_table'
          });
        }
      }
    });
  }

  // Mongoose
  const modelDirs = [
    path.join(projectRoot, 'src/models'),
    path.join(projectRoot, 'models')
  ];
  for (const dir of modelDirs) {
    if (!fs.existsSync(dir)) continue;
    scanDir(dir, projectRoot, (filePath, relPath) => {
      if (/\.(js|ts)$/.test(filePath) && !filePath.includes('.test.')) {
        const content = fs.readFileSync(filePath, 'utf8');
        const modelRegex = /mongoose\.model\s*\(\s*['"](\w+)['"]/g;
        let m;
        while ((m = modelRegex.exec(content)) !== null) {
          collections.push({
            name: m[1],
            file_path: relPath,
            type: 'mongoose_model'
          });
        }
      }
    });
  }

  return collections;
}

// =============================================================================
// FULL SCAN — discover and register everything
// =============================================================================

/**
 * Run a full codebase scan and register all discovered entries.
 *
 * @param {object} opts - { projectRoot?, dryRun? }
 * @returns {{ framework, registered, skipped, errors }}
 */
function fullScan(opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const dryRun = opts.dryRun || false;

  const fw = detectFramework(projectRoot);
  const registry = require('./project-registry');

  const result = {
    framework: fw,
    registered: { pages: 0, components: 0, apis: 0, database: 0 },
    skipped: { pages: 0, components: 0, apis: 0, database: 0 },
    errors: []
  };

  // Scan each domain
  const scans = [
    { domain: 'pages', items: scanPages(projectRoot, fw.framework) },
    { domain: 'components', items: scanComponents(projectRoot, fw.framework) },
    { domain: 'apis', items: scanAPIs(projectRoot, fw.framework) },
    { domain: 'database', items: scanDatabase(projectRoot) }
  ];

  for (const { domain, items } of scans) {
    for (const item of items) {
      if (dryRun) {
        result.registered[domain]++;
        continue;
      }

      const r = registry.register(domain, {
        ...item,
        created_by: 'auto-discovery'
      });

      if (r.success) {
        result.registered[domain]++;
      } else if (r.duplicate) {
        result.skipped[domain]++;
      } else {
        result.errors.push({ domain, name: item.name, error: r.error });
      }
    }
  }

  return result;
}

// =============================================================================
// HELPERS
// =============================================================================

function scanDir(dir, projectRoot, callback, maxDepth, depth) {
  maxDepth = maxDepth || 5;
  depth = depth || 0;
  if (depth > maxDepth) return;
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(projectRoot, fullPath);

    if (entry.isDirectory()) {
      scanDir(fullPath, projectRoot, callback, maxDepth, depth + 1);
    } else if (entry.isFile()) {
      callback(fullPath, relPath);
    }
  }
}

function getPageDirs(projectRoot, framework) {
  if (framework === 'nextjs') {
    return [
      path.join(projectRoot, 'app'),
      path.join(projectRoot, 'src/app'),
      path.join(projectRoot, 'pages'),
      path.join(projectRoot, 'src/pages')
    ];
  }
  return [
    path.join(projectRoot, 'src/pages'),
    path.join(projectRoot, 'pages'),
    path.join(projectRoot, 'src/views'),
    path.join(projectRoot, 'views')
  ];
}

function getComponentDirs(projectRoot) {
  return [
    path.join(projectRoot, 'src/components'),
    path.join(projectRoot, 'components'),
    path.join(projectRoot, 'src/ui'),
    path.join(projectRoot, 'ui')
  ];
}

function getAPIDirs(projectRoot, framework) {
  if (framework === 'nextjs') {
    return [
      path.join(projectRoot, 'app/api'),
      path.join(projectRoot, 'src/app/api'),
      path.join(projectRoot, 'pages/api'),
      path.join(projectRoot, 'src/pages/api')
    ];
  }
  return [
    path.join(projectRoot, 'src/api'),
    path.join(projectRoot, 'api'),
    path.join(projectRoot, 'src/routes'),
    path.join(projectRoot, 'routes')
  ];
}

function isPageFile(filePath, framework) {
  if (framework === 'nextjs') {
    return /page\.(tsx|jsx|ts|js)$/.test(filePath) ||
           (/\.(tsx|jsx)$/.test(filePath) && !filePath.includes('layout') &&
            !filePath.includes('loading') && !filePath.includes('error') &&
            !filePath.includes('not-found'));
  }
  return /\.(tsx|jsx|vue|svelte)$/.test(filePath) &&
         !filePath.includes('.test.') && !filePath.includes('.spec.');
}

function isComponentFile(filePath) {
  return /\.(tsx|jsx|vue|svelte)$/.test(filePath) &&
         !filePath.includes('.test.') && !filePath.includes('.spec.') &&
         !filePath.includes('.stories.');
}

function isAPIFile(filePath, framework) {
  if (framework === 'nextjs') {
    return /route\.(ts|js)$/.test(filePath);
  }
  return /\.(ts|js|mjs)$/.test(filePath) &&
         !filePath.includes('.test.') && !filePath.includes('.spec.');
}

function pageNameFromPath(relPath, framework) {
  const parsed = path.parse(relPath);
  if (framework === 'nextjs' && parsed.name === 'page') {
    return path.dirname(relPath).split(path.sep).pop() || 'index';
  }
  return parsed.name;
}

function componentNameFromPath(relPath) {
  const parsed = path.parse(relPath);
  if (parsed.name === 'index') {
    return path.dirname(relPath).split(path.sep).pop() || 'index';
  }
  return parsed.name;
}

function apiNameFromPath(relPath, framework) {
  const parsed = path.parse(relPath);
  if (framework === 'nextjs' && parsed.name === 'route') {
    const dir = path.dirname(relPath);
    return 'API ' + dir.replace(/^(src\/)?app\/api\//, '/').replace(/\\/g, '/');
  }
  return parsed.name;
}

function routeFromPath(relPath, framework) {
  let route = relPath
    .replace(/^(src\/)?(app|pages)\//, '/')
    .replace(/\.(tsx|jsx|ts|js|vue|svelte)$/, '')
    .replace(/\/page$/, '')
    .replace(/\/index$/, '')
    .replace(/\\/g, '/');

  if (!route.startsWith('/')) route = '/' + route;
  return route || '/';
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  detectFramework,
  scanPages,
  scanComponents,
  scanAPIs,
  scanDatabase,
  fullScan
};
