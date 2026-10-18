import type { ToolAdapter } from "../core/types.js";
import { aderyn } from "./aderyn.js";
import { astgrep } from "./astgrep.js";
import { attw } from "./attw.js";
import { basedpyright } from "./basedpyright.js";
import { biome, biomeFormat } from "./biome.js";
import { blobs } from "./blobs.js";
import { brakeman } from "./brakeman.js";
import { capslock } from "./capslock.js";
import { buildifier } from "./buildifier.js";
import { buf } from "./buf.js";
import { bufBreaking } from "./buf-breaking.js";
import { bufFormat } from "./buf-format.js";
import { cargoDeny } from "./cargo-deny.js";
import { cargoHack } from "./cargo-hack.js";
import { cargoMachete } from "./cargo-machete.js";
import { cargoMutants } from "./cargo-mutants.js";
import { clangFormat } from "./clang-format.js";
import { clangTidy } from "./clang-tidy.js";
import { cargoSemverChecks } from "./cargo-semver-checks.js";
import { clippy } from "./clippy.js";
import { cooldown } from "./cooldown.js";
import { crosshair } from "./crosshair.js";
import { credo } from "./credo.js";
import { csharpier } from "./csharpier.js";
import { cppcheck } from "./cppcheck.js";
import { dartAnalyze, dartFormat } from "./dart.js";
import { deadnix } from "./deadnix.js";
import { deadcode } from "./deadcode.js";
import { dependencyCruiser } from "./dependency-cruiser.js";
import { deptry } from "./deptry.js";
import { detekt } from "./detekt.js";
import { diffCover } from "./diff-cover.js";
import { dotnetBuild } from "./dotnet-build.js";
import { dotnetFormat } from "./dotnet-format.js";
import { env } from "./env.js";
import { forgeFmt } from "./forge-fmt.js";
import { eslint } from "./eslint.js";
import { fileLength } from "./file-length.js";
import { gitleaks } from "./gitleaks.js";
import { gofmt } from "./gofmt.js";
import { gofumpt } from "./gofumpt.js";
import { goArchLint } from "./go-arch-lint.js";
import { graphqlInspector } from "./graphql-inspector.js";
import { goRace } from "./go-race.js";
import { golangci } from "./golangci.js";
import { googleJavaFormat } from "./google-java-format.js";
import { gorelease } from "./gorelease.js";
import { govulncheck } from "./govulncheck.js";
import { gremlins } from "./gremlins.js";
import { hadolint } from "./hadolint.js";
import { htmlValidate } from "./html-validate.js";
import { hlint } from "./hlint.js";
import { importLinter } from "./import-linter.js";
import { jscpd } from "./jscpd.js";
import { kani } from "./kani.js";
import { knip } from "./knip.js";
import { ktlint } from "./ktlint.js";
import { kubeLinter } from "./kube-linter.js";
import { kubeconform } from "./kubeconform.js";
import { lizard } from "./lizard.js";
import { lsLint } from "./ls-lint.js";
import { lychee } from "./lychee.js";
import { markdownlint } from "./markdownlint.js";
import { migrations } from "./migrations.js";
import { mixFormat } from "./mix-format.js";
import { miri } from "./miri.js";
import { mutmut } from "./mutmut.js";
import { mypy } from "./mypy.js";
import { nilaway } from "./nilaway.js";
import { nixfmt } from "./nixfmt.js";
import { oasdiff } from "./oasdiff.js";
import { ocamlformat } from "./ocamlformat.js";
import { ormolu } from "./ormolu.js";
import { osvScanner } from "./osv.js";
import { oxlint } from "./oxlint.js";
import { pmd } from "./pmd.js";
import { paths } from "./paths.js";
import { phpCsFixer } from "./php-cs-fixer.js";
import { phpstan } from "./phpstan.js";
import { pint } from "./pint.js";
import { pluto } from "./pluto.js";
import { policy } from "./policy.js";
import { publint } from "./publint.js";
import { prettier } from "./prettier.js";
import { rubocop } from "./rubocop.js";
import { ruff } from "./ruff.js";
import { ruffFormat } from "./ruff-format.js";
import { rustfmt } from "./rustfmt.js";
import { scalafmt } from "./scalafmt.js";
import { scripts } from "./scripts.js";
import { selene } from "./selene.js";
import { semgrep } from "./semgrep.js";
import { shellcheck } from "./shellcheck.js";
import { sizeLimit } from "./size-limit.js";
import { slither } from "./slither.js";
import { solhint } from "./solhint.js";
import { sqlcDiff } from "./sqlc-diff.js";
import { sqlcVet } from "./sqlc-vet.js";
import { sqruff } from "./sqruff.js";
import { squawk } from "./squawk.js";
import { statix } from "./statix.js";
import { stylua } from "./stylua.js";
import { stryker } from "./stryker.js";
import { taplo } from "./taplo.js";
import { stylelint } from "./stylelint.js";
import { swiftFormat } from "./swift-format.js";
import { swiftlint } from "./swiftlint.js";
import { lean } from "./lean.js";
import { quint } from "./quint.js";
import { reuse } from "./reuse.js";
import { tflint } from "./tflint.js";
import { tlc } from "./tlc.js";
import { tofu } from "./tofu.js";
import { trivy } from "./trivy.js";
import { tsc } from "./tsc.js";
import { ty } from "./ty.js";
import { typos } from "./typos.js";
import { unicode } from "./unicode.js";
import { vulture } from "./vulture.js";
import { yamllint } from "./yamllint.js";
import { zigAstCheck, zigFmt } from "./zig.js";
import { zizmor } from "./zizmor.js";

/**
 * Every tool integration the engine knows about. Drives detection→activation,
 * `check doctor`, and the install matrix. Order here is informational; the runner
 * orders execution by layer.
 */
export const TOOL_REGISTRY: ToolAdapter[] = [
  // format
  prettier,
  biomeFormat,
  ruffFormat,
  rustfmt,
  gofmt,
  gofumpt,
  taplo,
  forgeFmt,
  dotnetFormat,
  csharpier,
  phpCsFixer,
  pint,
  mixFormat,
  clangFormat,
  zigFmt,
  googleJavaFormat,
  scalafmt,
  // opt-in languages' formatters: each where the project chose it
  swiftFormat,
  dartFormat,
  stylua,
  ormolu,
  ocamlformat,
  nixfmt,
  bufFormat,
  tofu,
  // lint
  oxlint,
  eslint,
  biome,
  ruff,
  clippy,
  golangci,
  deadcode,
  nilaway,
  shellcheck,
  squawk,
  // infrastructure and docs files: Dockerfiles, YAML, Markdown, links,
  // file names, licences
  hadolint,
  yamllint,
  markdownlint,
  lychee,
  lsLint,
  reuse,
  stylelint,
  htmlValidate,
  solhint,
  // opt-in languages' linters (buildifier: on in a Bazel workspace)
  swiftlint,
  dartAnalyze,
  selene,
  hlint,
  statix,
  deadnix,
  buildifier,
  knip,
  jscpd,
  typos,
  deptry,
  cargoMachete,
  dependencyCruiser,
  importLinter,
  lizard,
  publint,
  attw,
  vulture,
  rubocop,
  credo,
  dotnetBuild,
  clangTidy,
  cppcheck,
  zigAstCheck,
  pmd,
  ktlint,
  detekt,
  // schemas and infrastructure: Protobuf, SQL, GraphQL, Kubernetes, Terraform
  buf,
  bufBreaking,
  sqruff,
  graphqlInspector,
  kubeconform,
  kubeLinter,
  pluto,
  tflint,
  // the kit's own checks of what git stores: compiled output, names another
  // system cannot check out, scripts that cannot start
  blobs,
  paths,
  scripts,
  migrations,
  env,
  fileLength,
  // lint, deep tier: feature combinations, public API against a release,
  // imports between components
  cargoHack,
  cargoSemverChecks,
  gorelease,
  goArchLint,
  // type-check
  tsc,
  mypy,
  basedpyright,
  ty,
  phpstan,
  // custom-rules
  astgrep,
  // security
  semgrep,
  gitleaks,
  zizmor,
  unicode,
  cooldown,
  policy,
  cargoDeny,
  slither,
  aderyn,
  brakeman,
  capslock,
  trivy,
  // opt-in config-driven gates (vulnAudit / apiDiff)
  osvScanner,
  govulncheck,
  oasdiff,
  // formal
  tlc,
  lean,
  quint,
  crosshair,
  // behavior: the module's tests under the race detector, the changed lines
  // no test runs (deep tier), and a package's built size against its budget
  kani,
  // behavior: the module's tests under the race detector, the crate's under
  // Miri, and the changed lines no test runs (deep tier)
  goRace,
  miri,
  diffCover,
  sizeLimit,
  // generated SQL code that matches its queries, and the queries' rules
  sqlcVet,
  sqlcDiff,
  // mutation (opt-in, deep tier)
  stryker,
  cargoMutants,
  mutmut,
  gremlins,
];

export function adapterById(id: string): ToolAdapter | undefined {
  return TOOL_REGISTRY.find((a) => a.id === id);
}
