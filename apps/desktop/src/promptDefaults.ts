import {
  defaultPromptOverrides,
  type PromptOverrides,
} from "@gptdataexport/shared";

export interface PromptTemplates {
  personaObservationSystem: string;
  personaObservationUser: string;
  personaSynthesisSystem: string;
  personaSynthesisUser: string;
  memorySystem: string;
  memoryUser: string;
  memorySynthesisSystem: string;
  memorySynthesisUser: string;
}

export const defaultPromptTemplates: PromptTemplates = {
  ...defaultPromptOverrides,
};

function pickPrompt(
  overrides: Record<string, string> | undefined,
  ...keys: string[]
): string | undefined {
  if (!overrides) {
    return undefined;
  }
  for (const key of keys) {
    const value = overrides[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function resolvePromptTemplates(
  overrides: Record<string, string> | undefined,
): PromptTemplates {
  return {
    personaObservationSystem:
      pickPrompt(overrides, "personaObservationSystem", "persona_observation_system") ??
      defaultPromptTemplates.personaObservationSystem,
    personaObservationUser:
      pickPrompt(overrides, "personaObservationUser", "persona_observation_user") ??
      defaultPromptTemplates.personaObservationUser,
    personaSynthesisSystem:
      pickPrompt(overrides, "personaSynthesisSystem", "persona_synthesis_system") ??
      defaultPromptTemplates.personaSynthesisSystem,
    personaSynthesisUser:
      pickPrompt(overrides, "personaSynthesisUser", "persona_synthesis_user") ??
      defaultPromptTemplates.personaSynthesisUser,
    memorySystem:
      pickPrompt(overrides, "memorySystem", "memory_system") ??
      defaultPromptTemplates.memorySystem,
    memoryUser:
      pickPrompt(overrides, "memoryUser", "memory_user") ??
      defaultPromptTemplates.memoryUser,
    memorySynthesisSystem:
      pickPrompt(overrides, "memorySynthesisSystem", "memory_synthesis_system") ??
      defaultPromptTemplates.memorySynthesisSystem,
    memorySynthesisUser:
      pickPrompt(overrides, "memorySynthesisUser", "memory_synthesis_user") ??
      defaultPromptTemplates.memorySynthesisUser,
  };
}

export function fillPromptTemplate(template: string, values: Record<string, unknown>): string {
  let text = template;
  for (const [key, rawValue] of Object.entries(values)) {
    const value = String(rawValue ?? "");
    text = text.replaceAll(`{${key}}`, value);
  }
  return text;
}
