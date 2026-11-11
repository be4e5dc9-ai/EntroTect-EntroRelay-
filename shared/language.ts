export const languages = ['system', 'zh-CN', 'en'] as const;
export type LanguagePreference = typeof languages[number];
export type Language = Exclude<LanguagePreference, 'system'>;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return languages.some(language => language === value);
}

export function resolveLanguage(preference: LanguagePreference, system: string): Language {
  return preference === 'system' ? (/^zh(?:-|$)/i.test(system) ? 'zh-CN' : 'en') : preference;
}
