// The boundaries between this repository's parts, run by validate-kit
// (tools.dependency-cruiser in validate.config.ts names what it cruises).
// Package `exports` stop an import by package name only: a relative path
// such as ../../api/src ignores them, so the edges between parts are here.
// npm packages are left out of the graph: knip reports unlisted ones.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle of imports: move the shared part out, or invert one edge. Type-only imports are erased, so they do not count.",
      from: {},
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ["type-only"] },
      },
    },
    {
      name: "web-not-to-api",
      severity: "error",
      comment:
        "apps/web reaches the API over HTTP with the shapes in packages/contracts, never by importing its code.",
      from: { path: "^apps/web/" },
      to: { path: "^apps/api/" },
    },
    {
      name: "api-not-to-web",
      severity: "error",
      comment: "apps/api does not import the web app.",
      from: { path: "^apps/api/" },
      to: { path: "^apps/web/" },
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      comment:
        "A package is used by the apps, never the other way: move the shared code into the package.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "shipped-not-to-tests",
      severity: "error",
      comment: "Shipped code does not import tests or test helpers.",
      from: {
        path: "^(apps/api/src|apps/web/(app|components|lib)|packages/[^/]+/src)/",
        pathNot: "\\.(test|spec)\\.tsx?$",
      },
      to: { path: "(/test/|/e2e/|\\.(test|spec)\\.tsx?$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|dist|\\.next|samples|rule-tests)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
