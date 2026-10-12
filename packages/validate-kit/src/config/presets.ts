import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PresetName, ValidateConfig } from "../core/types.js";
import { kitPresetsDir } from "../core/paths.js";

/**
 * Built-in presets. Every layer is enabled by the config defaults; a preset
 * is only the ast-grep rule subset loaded from presets/*.txt.
 */
const presetFiles: Record<PresetName, string> = {
  recommended: "recommended.txt",
  strict: "strict.txt",
  security: "security.txt",
  ci: "strict.txt",
};

function readPresetRuleIds(name: PresetName): string[] {
  return readFileSync(join(kitPresetsDir(), presetFiles[name]), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export const PRESET_RULE_IDS: Record<PresetName, string[]> = {
  recommended: readPresetRuleIds("recommended"),
  strict: readPresetRuleIds("strict"),
  security: readPresetRuleIds("security"),
  ci: readPresetRuleIds("ci"),
};

export const PRESETS: Record<PresetName, ValidateConfig> = {
  recommended: {
    astGrep: { ruleIds: PRESET_RULE_IDS.recommended },
  },
  strict: {
    astGrep: { ruleIds: PRESET_RULE_IDS.strict },
  },
  security: {
    astGrep: { ruleIds: PRESET_RULE_IDS.security },
  },
  ci: {
    astGrep: { ruleIds: PRESET_RULE_IDS.ci },
  },
};
