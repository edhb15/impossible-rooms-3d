# IMPOSSIBLE ROOMS

A first-person 3D puzzle and escape game that runs in the browser, built with HTML, CSS, JavaScript and three.js.

You wake up inside a facility whose rooms ignore physics. Hallways loop back on themselves, doors lead to places that can't exist, gravity points wherever you tell it to, portals connect far-apart walls, and some bridges only exist if you look at them from the right spot. Solve five chambers to escape.

All geometry, textures and sound are generated procedurally at runtime. The game uses no external models, images or audio files, and needs no build step.

---

## Running the game

The game uses JavaScript modules and an import map, and browsers block both on `file://` pages. So you have to serve the folder over HTTP instead of opening `index.html` directly:

```bash
# from the project folder — pick one
python3 -m http.server 8000
npx serve .
npx http-server -p 8000
```

Then open **http://localhost:8000** in a desktop browser.

If you open `index.html` by double-clicking it, the page shows a message explaining that a local server is needed.

**Requirements**
- A current browser with **WebGL 2**: Chrome, Edge, Firefox or Safari on desktop, or Chrome / Safari on a phone or tablet (iOS 15+, recent Android).
- A mouse and keyboard, **or** a touchscreen. The desktop version uses the Pointer Lock API for mouse look; phones and tablets get on-screen touch controls automatically.
- three.js is included in `lib/`, so the game itself works offline. The only network request is for the Google Fonts (Orbitron / Rajdhani). If that request fails, the game falls back to system fonts.

If WebGL 2 is unavailable, the game shows an explanation instead of a blank page.

### Playing on a phone or tablet

The same page is the mobile version. It switches to touch controls automatically when it detects a touchscreen.

1. Serve the folder on your network so your phone can reach it, e.g. `python3 -m http.server 8000 --bind 0.0.0.0`, then open `http://<your-computer's-IP>:8000` on the phone (both devices on the same Wi-Fi). Or host the folder on any static host (GitHub Pages, Netlify, …).
2. Hold the phone in **landscape**. In portrait the game pauses and asks you to rotate.
3. For true fullscreen:
   - **Android (Chrome):** the game goes fullscreen and locks to landscape when you tap Play. You can also use *Add to Home screen* to install it as an app.
   - **iPhone / iPad (Safari):** Safari can't make a web page fullscreen, so use *Share → Add to Home Screen* and launch it from the icon. It then opens fullscreen with no browser bars.

On first launch on a touch device, the graphics quality defaults to *Medium*, or *Low* on devices with 4 or fewer CPU cores. You can change this in Settings. **Settings → Touch controls** can force touch controls on (for example on a touchscreen laptop) or off (for example on a tablet with a keyboard and mouse).

---

## Controls

### Touch

| Control | Action |
|---|---|
| **Left thumb**: drag anywhere on the left half | Move (a joystick appears under your thumb). Push it all the way to sprint. |
| **Right thumb**: drag anywhere on the right half | Look around |
| **JUMP** | Jump |
| **USE** | Interact, pick up, use panels. The button lights up when the crosshair is on something usable, and becomes **DROP** while you're holding something. |
| **↺** | Reset the puzzle to the last checkpoint |
| **?** | Show the next hint |
| **❚❚** | Pause |

You can move and look at the same time, with one thumb on each side of the screen.

### Keyboard and mouse

| Input | Action |
|---|---|
| **W A S D** | Move |
| **Mouse** | Look around |
| **Space** | Jump |
| **Shift** | Sprint |
| **E** | Interact: press buttons, open doors, pick up / drop, insert cores and keycards, use gravity panels, lock perspective |
| **Click** | Lock the mouse / resume, or drop the held object |
| **R** | Reset the puzzle (go back to the last checkpoint) |
| **H** | Show the next hint (press repeatedly to cycle through them) |
| **Esc** | Pause and release the mouse |

The controls guide appears at the start of Level 1. You can also open it from the pause menu at any time. When the crosshair is on something you can use, a prompt tells you what **E** will do.

---

## The five chambers

| # | Chamber | What it teaches |
|---|---|---|
| 1 | **The Beginning** | Moving, jumping, buttons, carrying cubes, pressure plates, locked exits. |
| 2 | **The Impossible Hallway** | A corridor that loops forever. Doors teleport you, and only a symbol you can see from one exact spot tells you which door is real. It ends in the **Scale Room**, where objects are exactly as large as they *appear*. |
| 3 | **The Gravity Chamber** | Gravity panels turn walls and ceilings into floors. You retrieve an energy core and reach an exit that hangs upside-down by the ceiling. |
| 4 | **The Portal Lab** | Two pairs of see-through portals. You carry cubes and a keycard through portals to reach a sealed cell and an unreachable balcony. |
| 5 | **The Broken Dimension** | Everything together: a forced-perspective bridge, a conduit that rotates, a moving platform, a monolith whose face becomes the floor, and a portal into the final chamber. It ends with an escape sequence. |

Each level has an on-screen objective that updates as you progress, plus optional hints (**H**). Every level has been played through to its exit by an automated test that drives the real game simulation.

### Getting unstuck
- **R** reloads the current puzzle from its last checkpoint. Level 2 checkpoints at the Scale Room, and Level 5 checkpoints at each platform.
- Falling into the void returns you to the last checkpoint automatically.
- A cube, core or block that falls out of the world returns to where it started.
- The Level 3 core is recalled to its cradle if it lands somewhere you can't reach.
- Doors never close on you or on a cube.

---

## Interface and settings

- **Main menu:** Play / Continue, Level Select, Settings, Credits.
- **HUD:** crosshair, interaction prompts, level name and objective, hints, a progress bar with one marker per level, the level timer, and a gravity indicator in the gravity levels.
- **Pause menu** (Esc): Resume, Restart Level, Controls, Settings, Main Menu.
- **Victory screen:** total completion time with a per-level breakdown, and a Replay button.
- **Settings:** master / music / effects volume, mute, look sensitivity, invert Y, field of view, graphics quality (Low / Medium / High), auto-show hints, head bob, touch controls (Auto / On / Off).

Progress, best times and settings are saved in `localStorage` under the key `impossibleRooms.save.v1`. **Settings → Reset Progress** clears levels and times but keeps your settings.

---

## How the mechanics work

- **Gravity rotation.** Gravity always points along one of the six axes. The player keeps a "body frame" quaternion that maps world-up onto their current up. Movement, jumping and collision are all computed in that frame, so walking on walls is real movement, not a rotated camera. When gravity changes, the frame turns smoothly (a 180° change rolls the view over), and loose objects fall the new way too.
- **Collision.** The physics uses axis-aligned boxes with per-axis, sub-stepped movement, step-up onto low ledges, depenetration, and support for moving and rotating platforms. Rotating rooms turn in 90° steps, so their colliders stay axis-aligned.
- **Portals.** Each portal renders the view from its partner into a render target. The view is drawn from a virtual camera (`partner · rotY(π) · inverse(portal) · camera`) with an oblique near plane, so nothing behind the far portal appears. The player and objects that pass through are transformed by the same matrix: position, velocity and view direction all carry over. If a portal changes your orientation, your gravity follows.
- **Forced perspective.** Pieces of the bridge and the hallway symbols are moved along rays from a single viewpoint and scaled in proportion. From that spot they line up perfectly; from anywhere else they are scattered fragments. Locking the perspective pulls the bridge pieces back to their true positions, still lined up along the same rays.
- **Size illusion.** A held perception block keeps its *angular* size. Each frame the game pushes it as far along your view ray as it will fit, so look at a distant wall and it becomes enormous. Pressure plates check the block's real size.
- **Audio.** Everything you hear is synthesised with the Web Audio API: facility hum, footsteps, switches, doors, portals, gravity shifts, generative ambient music, completion stingers and the finale.

---

## Project structure

```
index.html        Page shell, HUD/menus/touch-controls markup, import map, boot error handling
style.css         Interface styles (desktop and mobile)
game.js           The whole game (ES module)
manifest.webmanifest, icon.svg, icon-*.png
                  "Add to Home Screen" support: fullscreen, landscape, app icon
lib/
  three.module.min.js            three.js r170 (MIT)
  addons/postprocessing/...      EffectComposer, RenderPass, UnrealBloomPass, OutputPass
  addons/shaders/...             shaders used by those passes
  THREE-LICENSE.txt
```

`game.js` is organised top-down:

1. Core helpers, save data and the procedural `AudioEngine`
2. Procedural textures, materials and geometry helpers
3. Physics (`PhysicsWorld`, `moveBody`) and the gravity-aware `Player`
4. Entities: `Switch`, `Door`, `PressurePlate`, `PhysObject`, `Socket`, `GravityPanel`, `Trigger`, `MovingPlatform`, `RotatingGroup`, `Portal`, `PerspectiveBridge`, `PerspectiveGlyph`, `ParticleField`
5. The `Level` base class with builder helpers, then `Level1` … `Level5`
6. The menu backdrop (an impossible triangle that only closes from one viewpoint) and the `UI` controller
7. `TouchControls`: floating joystick, drag-to-look and on-screen buttons
8. `Game`: renderer, post-processing, main loop, state machine, input, holding/interaction, portal rendering and level flow

`window.IR` exposes the running game instance in the browser console.

---

## Troubleshooting

- **"Please use a local server"**: see [Running the game](#running-the-game).
- **The mouse doesn't lock**: click inside the game. If you just pressed Esc, browsers make you wait about a second before the mouse can be locked again. If pointer lock is blocked entirely (for example in some embedded frames), the game switches to hold-a-mouse-button-and-drag to look.
- **Low frame rate**: set **Settings → Graphics quality** to *Medium* or *Low*. This lowers the resolution scale, shadows, bloom and portal resolution.
- **Touch controls missing / showing on a laptop**: change **Settings → Touch controls** (Auto-detect / Always on / Off).
- **The page zooms or scrolls on a phone**: launch it from the home screen icon (see [Playing on a phone or tablet](#playing-on-a-phone-or-tablet)). Pinch-zoom and scrolling are disabled while you play.
- **No sound**: the browser only starts audio after your first click. Also check the volume sliders and the mute toggle in Settings.

---

## Credits

Design, code, procedural art and audio for this project. Rendering by [three.js](https://threejs.org) (MIT License, see `lib/THREE-LICENSE.txt`). Fonts: Orbitron and Rajdhani (SIL Open Font License) via Google Fonts.
