# Gravity

A motorcycle trials game for the browser, in the spirit of the old mobile classic Gravity Defied. Ride a dirt bike over generated tracks, keep the rubber side down, and reach the flag. Land on your head and you start over.

Everything is made in code: the physics, the levels, the graphics, the sound, and the AI riders you can race. There are no asset files.

## Play

You need a recent [Bun](https://bun.sh) (developed on 1.4).

```bash
bun install
bun start
```

`bun start` serves the game at http://localhost:3210 and opens it in your browser. Use `bun start --no-open` to skip opening the browser, and `PORT=4000 bun start` for another port.

### Controls

| Key | Action |
| --- | --- |
| ↑ / W | Throttle |
| ↓ / S | Brake |
| ← / A | Lean back |
| → / D | Lean forward |
| R | Restart |
| Space / Enter | Restart after a crash |
| Esc / P | Pause |
| M | Sound on/off |

Menus work with the arrow keys, Enter or Space, and Esc to go back.

## What's in it

- **Standard**: 100 levels of rising difficulty. Past level 20, holding the throttle is no longer enough.
- **Planets**: the Moon, Mars and Mercury. Lighter gravity, huge slow jumps, tracks twice as long.
- **Super-Earths**: 2×, 3×, 5× and 10× gravity. Short jumps and brutal landings.
- **Race against AI**: easy (1 rider), medium (3), hard (10) and impossible (10 riders flat out on brutal tracks, each the fastest of three tries). The AI riders see one screen ahead, like you, and have never seen the track.
- **Impossible**: tracks at the edge of what the bike can do, never checked by the solver.
  - *Climb*: 10 levels of faces steeper than the engine can hold. Fall short, roll back, take a longer run-up. Each wall's height is measured against a climbing bot as it is built; the last level sits at (or past) its limit.
  - *Descent*: 10 levels of chutes, cliffs and rock gardens. Keep it level and ride the brakes.
  - *Campaign*: no last level. Each one you beat opens a slightly harder, longer one.
- **Custom track**: pick the difficulty, length (150–2000 m) and world.
- **Achievements**: 30 of them. You only see the ones you've earned.
- **Options**: blood, sound, screams, volume, ghost of your best run, camera shake, auto-restart.

Progress, records and options are saved in your browser's local storage. There are no accounts and nothing leaves your machine.

Your rider name is the seed for your tracks: the same name always gets the same levels, so two people using the same name can compare times on identical tracks.

## How it works

### Physics

A custom rigid-body simulation: a chassis and two wheels joined by spring-damper suspension, with tire friction, a breakable rear fender and a head-damage model (a light helmet scrape is survivable, a hard hit is not).

The simulation is **deterministic**, like Trackmania: it runs at a fixed 120 ticks per second, uses no trigonometry or randomness inside the step, and gives bit-identical results in Bun and in the browser. A run is fully described by the track, the bike settings and one input value per tick, which is how ghosts, replays and AI opponents work.

### Levels

Tracks are generated from a seed, a difficulty and a length. Besides hills and drops, harder tracks contain obstacles that need a particular skill: gaps that need speed, walls that need momentum, ledges that need the front wheel lifted, ditches that need the brakes.

Before you ride a track, a solver rides it first. A track is only used if the solver can finish it, and (above difficulty 20) only if holding the throttle alone cannot. Tracks that fail are regenerated.

### AI riders

The opponents are a small neural network (2,326 weights) trained with an evolution strategy, entirely in TypeScript. The rider sees 4 m behind and 16 m ahead of the bike plus the bike's own state, and decides 10 times a second. It was trained on a pool of verified 500 m tracks across all difficulties.

On tracks it has never seen, the included rider finishes nearly all of them up to difficulty 40, about half around difficulty 60–80, and few at 90–100.

To train it further (this resumes from `data/rider.json`):

```bash
MINUTES=60 bun src/ai/train.ts
```

To rebuild the pool of training tracks:

```bash
bun src/ai/pool.ts
```

## Development

```bash
bun run dev      # the game with a live tuning panel, hot reload, and every level unlocked
bun test         # physics, determinism, level, save, race and achievement tests
bun check        # type check
```

The tuning panel in dev mode exposes every bike parameter (suspension, engine, lean control, tires, crash thresholds) within safe ranges.

### Deploying

The game runs entirely in the browser, so it can be hosted as static files:

```bash
bun run build    # writes the site to dist/
```

Upload `dist/` to any static host. For Vercel, the included `vercel.json` does this automatically.

### Project layout

| Path | What it holds |
| --- | --- |
| `src/sim/` | The physics: config, state, the tick function, track collision |
| `src/level/` | Track generators (standard and impossible), solver, and the verified-level builder |
| `src/game/` | Game loop, input, replays, ragdoll |
| `src/render/` | Canvas renderer, particle effects, world themes |
| `src/audio/` | Synthesised engine, tires, impacts and voice (Web Audio) |
| `src/ai/` | Observation, policy network, training |
| `src/app/` | Saves, game modes, planets, races, achievements |
| `src/ui/` | Menus and the dev tuning panel |
| `src/env/` | A gym-style environment wrapper for experiments |
| `data/` | The trained rider and its training tracks |

The simulation, level and AI code has no browser dependencies and runs headless in Bun.

## Built with

[Bun](https://bun.sh) and TypeScript. The only runtime dependency is [lil-gui](https://lil-gui.georgealways.com/) for the dev tuning panel.
