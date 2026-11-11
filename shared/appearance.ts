export const accentColors = {
  pink: { label: '粉色', wash: '#FAEEF4', lightInk: '#873553', darkInk: '#F2C5DC', fill: '#E17EAD', title: '#A9396B' },
  blue: { label: '蓝色', wash: '#EBF2FE', lightInk: '#245596', darkInk: '#B8D3FF', fill: '#79A7F1', title: '#295FA6' },
  violet: { label: '紫色', wash: '#F2EDFA', lightInk: '#614292', darkInk: '#D9C5FB', fill: '#AD90E2', title: '#6A489D' },
  teal: { label: '青色', wash: '#E8F6F3', lightInk: '#216657', darkInk: '#A9E2D4', fill: '#63BAA6', title: '#246A5B' },
  amber: { label: '琥珀色', wash: '#FFF2E3', lightInk: '#81501D', darkInk: '#F4CE9B', fill: '#DCA26A', title: '#86521C' },
  graphite: { label: '石墨色', wash: '#EEEFF2', lightInk: '#4A5061', darkInk: '#CFD4E1', fill: '#A1A8BA', title: '#4C5364' },
} as const;

export type AccentColor = keyof typeof accentColors;
export const defaultAccent: AccentColor = 'pink';

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && Object.hasOwn(accentColors, value);
}
