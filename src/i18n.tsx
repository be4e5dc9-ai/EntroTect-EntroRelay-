import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveLanguage, type Language, type LanguagePreference } from '../shared/language';
import { systemLanguage } from './api';
import { english } from './messages.en';
import { diagnostics } from './diagnostics.en';

export type Translate = (source: string | undefined, ...values: (string | number | undefined)[]) => string;
const slot = /\{(\d+)\}/g;
const han = /\p{Script=Han}/u;
const dynamicDiagnostics = Object.entries(diagnostics).filter(([source]) => /\{\d+\}/.test(source)).map(([source, target]) => {
  const indexes = [...source.matchAll(slot)].map(match => Number(match[1]));
  const pattern = source.split(slot).filter((_, index) => index % 2 === 0)
    .map(fragment => fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)');
  return { pattern: new RegExp('^' + pattern + '$'), indexes, target };
});

function format(source: string, values: (string | number | undefined)[]) {
  return source.replace(slot, (_, index) => String(values[Number(index)] ?? ''));
}

function translateDiagnostic(source: string, depth = 0): string {
  if (!han.test(source) || depth > 3) return source;
  if (Object.hasOwn(diagnostics, source)) return diagnostics[source];
  for (const { pattern, indexes, target } of dynamicDiagnostics) {
    const match = pattern.exec(source);
    if (!match) continue;
    const values: string[] = [];
    indexes.forEach((index, position) => { values[index] = translateDiagnostic(match[position + 1], depth + 1); });
    return format(target, values);
  }
  // History warnings prefix the error with a session, file, or Harness name.
  const separator = source.indexOf('：');
  if (separator > 0) {
    const detail = source.slice(separator + 1);
    const translated = translateDiagnostic(detail, depth + 1);
    if (translated !== detail) return source.slice(0, separator) + ': ' + translated;
  }
  return source;
}

export function translator(locale: Language): Translate {
  return (source, ...values) => {
    if (!source) return '';
    const text = locale === 'en'
      ? (Object.hasOwn(english, source) ? english[source] : translateDiagnostic(source))
      : source;
    return values.length ? format(text, values) : text;
  };
}

type I18n = { locale: Language; t: Translate; setLanguage: (language: LanguagePreference) => void };
const I18nContext = createContext<I18n>({ locale: 'en', t: translator('en'), setLanguage: () => {} });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [preference, setLanguage] = useState<LanguagePreference>('system');
  const [system, setSystem] = useState(() => navigator.language);
  useEffect(() => {
    let current = true;
    async function readSystem() {
      const language = await systemLanguage().catch(() => undefined);
      if (current) setSystem(language ?? navigator.language);
    }
    void readSystem();
    window.addEventListener('languagechange', readSystem);
    window.addEventListener('focus', readSystem);
    return () => {
      current = false;
      window.removeEventListener('languagechange', readSystem);
      window.removeEventListener('focus', readSystem);
    };
  }, []);
  const locale = resolveLanguage(preference, system);
  useLayoutEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const context = useMemo(() => ({ locale, t: translator(locale), setLanguage }), [locale]);
  return <I18nContext.Provider value={context}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
