/** 用户外观 / 交互偏好（localStorage） */

export type ThemeId = "dark" | "studio" | "compact";
export type DensityId = "comfortable" | "compact";
export type AccentId = "amber" | "blue" | "teal";

export type LoomSettings = {
  theme: ThemeId;
  density: DensityId;
  accent: AccentId;
  showStatusStrip: boolean;
  showRailLabels: boolean;
};

export const DEFAULT_SETTINGS: LoomSettings = {
  theme: "studio",
  density: "comfortable",
  accent: "blue",
  showStatusStrip: true,
  showRailLabels: true,
};

const KEY = "loom.settings.v1";

export function loadSettings(): LoomSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<LoomSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(next: LoomSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function applySettingsToDocument(s: LoomSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.dataset.accent = s.accent;
  root.dataset.railLabels = s.showRailLabels ? "1" : "0";
}
