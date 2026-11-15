// The look of each world: sky, hills, ground and what hangs in the sky.

export interface Theme {
  skyTop: string;
  skyMid: string;
  skyBottom: string;
  hillFar: string;
  hillMid: string;
  hillNear: string;
  groundTop: string;
  groundBottom: string;
  strip: string;
  stripFar: string;
  stripEdge: string;
  /** Star brightness 0..1; `airless` skies show stars right down to the horizon. */
  stars: number;
  airless: boolean;
  /** Height of the background hills relative to Earth's. */
  hillScale: number;
  sun: { x: number; y: number; r: number; color: string; glow: string; glowSize: number };
  /** A second body in the sky. */
  body: { x: number; y: number; r: number; kind: "earth" | "moonlet" | "ringed" } | null;
  dust: string;
  dirt: string;
}

const earth: Theme = {
  skyTop: "#141a33",
  skyMid: "#4a3a6a",
  skyBottom: "#f0a878",
  hillFar: "#6f5a86",
  hillMid: "#463f68",
  hillNear: "#2b2947",
  groundTop: "#3a3452",
  groundBottom: "#13111c",
  strip: "#8f88ab",
  stripFar: "#6f6890",
  stripEdge: "#f2e9e4",
  stars: 1,
  airless: false,
  hillScale: 1,
  sun: { x: 0.7, y: 0.52, r: 0.045, color: "#ffe9c4", glow: "255,200,150", glowSize: 0.5 },
  body: null,
  dust: "#cdbfd0",
  dirt: "#5a4f6e",
};

/** Super-earths: the same green world, darker the heavier it gets. */
function superEarth(dark: number): Theme {
  // dark: 0 (2x) .. 1 (10x)
  const mixHex = (a: string, b: string) => {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const ch = (shift: number) => Math.round(((pa >> shift) & 255) + ((((pb >> shift) & 255) - ((pa >> shift) & 255)) * dark));
    return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
  };
  return {
    skyTop: mixHex("#0f2b2b", "#020706"),
    skyMid: mixHex("#2f7358", "#0a2117"),
    skyBottom: mixHex("#d3e58c", "#2c4a25"),
    hillFar: mixHex("#4f8f68", "#102a1c"),
    hillMid: mixHex("#31684c", "#0b1e14"),
    hillNear: mixHex("#1d4433", "#06130c"),
    groundTop: mixHex("#2a5440", "#0c1f15"),
    groundBottom: mixHex("#0a1711", "#020504"),
    strip: mixHex("#86c29a", "#2f5a3d"),
    stripFar: mixHex("#64a07a", "#234430"),
    stripEdge: mixHex("#ecf8dc", "#9fca8a"),
    stars: 0.5 + 0.5 * dark,
    airless: false,
    hillScale: 1 - 0.55 * dark,
    sun: { x: 0.68, y: 0.5, r: 0.05 + 0.03 * dark, color: mixHex("#f6ffc9", "#b7e07a"), glow: dark > 0.5 ? "120,200,90" : "210,240,150", glowSize: 0.5 - 0.15 * dark },
    body: dark >= 0.6 ? { x: 0.2, y: 0.2, r: 0.07, kind: "ringed" } : null,
    dust: mixHex("#c9dcc4", "#5f8a66"),
    dirt: mixHex("#2f5a40", "#14301f"),
  };
}

export const THEMES: Record<string, Theme> = {
  earth,
  moon: {
    skyTop: "#000000",
    skyMid: "#05060a",
    skyBottom: "#15161d",
    hillFar: "#4a4b54",
    hillMid: "#34353c",
    hillNear: "#212227",
    groundTop: "#4a4b53",
    groundBottom: "#0c0c0f",
    strip: "#b4b5be",
    stripFar: "#8c8d96",
    stripEdge: "#f4f4f6",
    stars: 1.4,
    airless: true,
    hillScale: 0.55,
    sun: { x: 0.82, y: 0.16, r: 0.03, color: "#ffffff", glow: "255,255,255", glowSize: 0.16 },
    body: { x: 0.24, y: 0.22, r: 0.075, kind: "earth" },
    dust: "#d5d6dc",
    dirt: "#6a6b74",
  },
  mars: {
    skyTop: "#3a2622",
    skyMid: "#a5623f",
    skyBottom: "#e6b983",
    hillFar: "#a25a3c",
    hillMid: "#7a3b28",
    hillNear: "#4f2319",
    groundTop: "#6b3222",
    groundBottom: "#1b0b08",
    strip: "#c4744d",
    stripFar: "#9c5638",
    stripEdge: "#f6d2a8",
    stars: 0.3,
    airless: false,
    hillScale: 1.25,
    sun: { x: 0.72, y: 0.4, r: 0.026, color: "#eef6ff", glow: "190,215,255", glowSize: 0.3 },
    body: { x: 0.3, y: 0.18, r: 0.012, kind: "moonlet" },
    dust: "#e0a57c",
    dirt: "#7a3b28",
  },
  mercury: {
    skyTop: "#000000",
    skyMid: "#0b0704",
    skyBottom: "#2a1a0c",
    hillFar: "#6a5c4c",
    hillMid: "#463c31",
    hillNear: "#2a231c",
    groundTop: "#54483b",
    groundBottom: "#100d0a",
    strip: "#b09f86",
    stripFar: "#857662",
    stripEdge: "#fff3d8",
    stars: 1.1,
    airless: true,
    hillScale: 0.7,
    sun: { x: 0.66, y: 0.3, r: 0.15, color: "#fffbe6", glow: "255,214,140", glowSize: 0.75 },
    body: null,
    dust: "#d8c8ac",
    dirt: "#6a5c4c",
  },
  super2: superEarth(0),
  super3: superEarth(0.3),
  super5: superEarth(0.62),
  super10: superEarth(1),
};

export function themeById(id: string): Theme {
  return THEMES[id] ?? earth;
}
