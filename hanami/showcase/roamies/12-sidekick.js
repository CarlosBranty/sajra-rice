// The chosen sidekick: the LED matrix dither blob, without the drips, with the agent layer on top.
Roamie.register(Roamie.ditherKit({
  id: 'sidekick', label: 'Sidekick', matrix: true, pixel: 1.3, speed: 80,
  // Its five LED levels, and how much of its glow is kept, are the colour scheme's (theme.js), read every frame.
  glow: () => 0.55 * Roamie.theme.now.glow,
  pal: () => Roamie.theme.now.led,
  plugin: (kit) => Roamie.agentPlugin?.(kit) ?? null,
}));
