import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { run } from "../core/exec.js";
import { EXIT } from "../core/exit-codes.js";
import { getKitRoot } from "../core/paths.js";
import { LANGUAGES, type Language } from "../core/types.js";

/**
 * The languages the bundled ast-grep rules are written for; shell is
 * shellcheck's, sql squawk's, solidity Slither's (ast-grep has no Solidity
 * grammar), and the others have their own linters.
 */
const AST_GREP_LANGUAGES = ["ts", "js", "rust", "go", "python"] as const;
type RuleLanguage = (typeof AST_GREP_LANGUAGES)[number] & Language;
export const RULE_LANGUAGES = LANGUAGES.filter((lang): lang is RuleLanguage =>
  (AST_GREP_LANGUAGES as readonly string[]).includes(lang),
);

/** Proxy to `ast-grep test` — the rule snapshot harness. */
export async function rulesTestCommand(flags: {
  update?: boolean;
  validityOnly?: boolean;
}): Promise<number> {
  const kitRoot = getKitRoot();
  const args = ["test"];
  if (flags.update) args.push("-U");
  if (flags.validityOnly) args.push("--skip-snapshot-tests");
  const raw = await run("ast-grep", args, { cwd: kitRoot, timeoutMs: 120_000 });
  if (raw.spawnError) {
    process.stderr.write(
      pc.red("ast-grep not found. Install: brew install ast-grep\n"),
    );
    return EXIT.INCOMPLETE;
  }
  process.stdout.write(raw.stdout);
  if (raw.stderr) process.stderr.write(raw.stderr);
  return raw.exitCode === 0 ? EXIT.CLEAN : EXIT.FINDINGS;
}

const AG_LANG: Record<RuleLanguage, string> = {
  ts: "typescript",
  js: "javascript",
  rust: "rust",
  go: "go",
  python: "python",
};
const RULE_DIR_LANG: Record<RuleLanguage, string> = AG_LANG;
const RULE_ID_PREFIX: Record<RuleLanguage, string> = {
  ts: "ts",
  js: "js",
  rust: "rust",
  go: "go",
  python: "py",
};

// Compilable starter pattern + fixtures per language, so a fresh scaffold
// PASSES `ast-grep test` immediately (prose placeholders made every scaffold
// start life as a red suite, indistinguishable from a genuinely broken rule).
const SCAFFOLD: Record<
  RuleLanguage,
  { pattern: string; invalid: string; valid: string }
> = {
  ts: { pattern: "debugger", invalid: "debugger;", valid: "const ok = 1;" },
  js: { pattern: "debugger", invalid: "debugger;", valid: "const ok = 1;" },
  rust: {
    pattern: "todo!()",
    invalid: "fn f() { todo!() }",
    valid: "fn f() {}",
  },
  go: {
    pattern: "panic($$$A)",
    invalid: "package p\nfunc f() { panic(1) }",
    valid: "package p\nfunc f() {}",
  },
  python: { pattern: "breakpoint()", invalid: "breakpoint()", valid: "x = 1" },
};

const CATEGORIES = new Set([
  "correctness",
  "security",
  "performance",
  "style",
  "maintainability",
]);

function isLanguage(value: string): value is RuleLanguage {
  return (RULE_LANGUAGES as readonly string[]).includes(value);
}

function isRuleId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Scaffold a new ast-grep rule + its test stub. */
export function rulesNewCommand(
  lang: string,
  category: string,
  id: string,
  opts: { kitRoot?: string } = {},
): number {
  if (!isLanguage(lang)) {
    process.stderr.write(
      pc.red(
        `Invalid language '${lang}'. Expected one of: ${RULE_LANGUAGES.join(", ")}\n`,
      ),
    );
    return EXIT.CONFIG;
  }
  if (!CATEGORIES.has(category)) {
    process.stderr.write(
      pc.red(
        `Invalid category '${category}'. Expected one of: ${[...CATEGORIES].join(", ")}\n`,
      ),
    );
    return EXIT.CONFIG;
  }
  if (!isRuleId(id)) {
    process.stderr.write(
      pc.red(`Invalid rule id '${id}'. Expected kebab-case lowercase id.\n`),
    );
    return EXIT.CONFIG;
  }

  const kitRoot = opts.kitRoot ?? getKitRoot();
  const agLang = AG_LANG[lang];
  const ruleLangDir = RULE_DIR_LANG[lang];
  const ruleDir = join(kitRoot, "rules", ruleLangDir, category);
  const testDir = join(kitRoot, "rule-tests", ruleLangDir);
  const fullId = `${RULE_ID_PREFIX[lang]}-${id}`;
  const rulePath = join(ruleDir, `${id}.yml`);
  const testPath = join(testDir, `${fullId}-test.yml`);

  if (existsSync(rulePath)) {
    process.stderr.write(pc.red(`Rule already exists: ${rulePath}\n`));
    return EXIT.CONFIG;
  }
  if (existsSync(testPath)) {
    process.stderr.write(pc.red(`Rule test already exists: ${testPath}\n`));
    return EXIT.CONFIG;
  }

  mkdirSync(ruleDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    rulePath,
    `id: ${fullId}
language: ${agLang}
severity: warning
message: "EDIT ME: describe the smell"
note: |
  EDIT ME: why this matters and the recommended fix. The starter pattern below
  is a compilable placeholder so \`check rules test\` stays green until you
  replace it with the real rule.
rule:
  pattern: ${JSON.stringify(SCAFFOLD[lang].pattern)}
metadata:
  category: ${category}
  autofix: none
  since: "0.1.0"
`,
  );
  writeFileSync(
    testPath,
    `id: ${fullId}
valid:
  - ${JSON.stringify(SCAFFOLD[lang].valid)}
invalid:
  - ${JSON.stringify(SCAFFOLD[lang].invalid)}
`,
  );

  process.stdout.write(
    pc.green(`Created rule ${fullId}\n`) +
      `  rule: ${rulePath}\n  test: ${testPath}\n` +
      pc.dim(
        "Next: fill the pattern + cases, then `check rules test --update` to seed the snapshot.\n",
      ),
  );
  return EXIT.CLEAN;
}
