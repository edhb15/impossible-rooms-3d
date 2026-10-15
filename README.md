# IMPOSSIBLE ROOMS

A first-person 3D puzzle and escape game that runs in the browser, built with HTML, CSS, JavaScript and three.js.

You wake up inside a facility whose rooms ignore physics. Hallways loop back on themselves, doors lead to places that can't exist, gravity points wherever you tell it to, portals connect far-apart walls, and some bridges only exist if you look at them from the right spot. Solve five chambers to escape.

Then the light sets you down somewhere older. **Part II** takes place in an ancient Maya temple in the jungle: no gravity tricks or portals here, but puzzles in stone and a lot of traps. You gather sacred offerings to open sealed doors, read bar-and-dot numerals, bend sunlight with bronze mirrors, push carved blocks, and outrun blades, fire and a rolling boulder. Ten levels in all.

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
- three.js is included in `lib/`, so the game itself works offline. The only network request is for the Google Fonts (Orbitron, Rajdhani and Cinzel). If that request fails, the game falls back to system fonts.

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
| **E** | Interact: press buttons, open doors, pick up / drop, insert cores and keycards, use gravity panels, lock perspective; in the temple: take and place offerings, turn dials and mirrors, push blocks, pull levers |
| **Click** | Lock the mouse / resume, or drop the held object |
| **R** | Reset the puzzle (go back to the last checkpoint) |
| **H** | Show the next hint (press repeatedly to cycle through them) |
| **Esc** | Pause and release the mouse |

The controls guide appears at the start of Level 1. You can also open it from the pause menu at any time. When the crosshair is on something you can use, a prompt tells you what **E** will do.

---

## The levels

### Part I · The Facility

| # | Chamber | What it teaches |
|---|---|---|
| 1 | **The Beginning** | Moving, jumping, buttons, carrying cubes, pressure plates, locked exits. |
| 2 | **The Impossible Hallway** | A corridor that loops forever. Doors teleport you, and only a symbol you can see from one exact spot tells you which door is real. It ends in the **Scale Room**, where objects are exactly as large as they *appear*. |
| 3 | **The Gravity Chamber** | Gravity panels turn walls and ceilings into floors. You retrieve an energy core and reach an exit that hangs upside-down by the ceiling. |
| 4 | **The Portal Lab** | Two pairs of see-through portals. You carry cubes and a keycard through portals to reach a sealed cell and an unreachable balcony. |
| 5 | **The Broken Dimension** | Everything together: a forced-perspective bridge, a conduit that rotates, a moving platform, a monolith whose face becomes the floor, and a portal into the final chamber. Its escape sequence carries you into Part II. |

### Part II · The Sunken Temple

| # | Level | What happens |
|---|---|---|
| 6 | **The Jungle Gate** | A moonlit plaza before a pyramid. The **Gate of the Five** needs five different offerings, each guarded by its own trial: a Jade Mask on an open altar, a Sun Disc on a platform you reach by pushing a carved block against it, an Obsidian Blade past rows of rising spikes, a Quetzal Feather behind a door sealed by three glyph dials, and a Serpent Idol across a cenote of crumbling stepping stones. Pillars of light mark where each offering lies. |
| 7 | **The Hall of Counting** | Maya numbers are bars and dots. A mural teaches them; the **Counting Floor** must be crossed by stepping on 1, 2, 3 … 13 in order (any other stone drops you onto spikes); the **Corridor of Darts** fires in a rolling wave and hides three murals counting each god's offerings; three numeral dials beneath the gods open the way. |
| 8 | **The Serpent's Eye** | Sunlight enters through slits in the walls. Turn bronze mirrors to guide the beam into a jade eye, split it with a jade prism, and push a mirror mounted on a stone block into place to light both eyes of a serpent facade. Its mouth opens onto the **Bridge of Blades**. |
| 9 | **The Trial of Traps** | A gauntlet: seven swinging blades, a hall of fire vents that burn in alternating rows, a chamber whose ceiling falls once you take the Heart of Jade, and a long stair down which a great stone rolls after you. Sprint. |
| 10 | **The Five Directions** | The heart of the pyramid. Four passages lead to the red East (dawn light and mirrors), the white North (sums in bars and dots), the black West (crumbling stones and darts in the dark) and the yellow South (push both blocks onto the sun plates). Set the four stones in the World Tree and steps rise to the green heart of the world — and the temple lets you go. |

Each level has an on-screen objective that updates as you progress, plus optional hints (**H**). Every level has been played through to its exit by an automated test that drives the real game simulation; the temple traps were also checked to kill a careless player.

### Getting unstuck
- **R** reloads the current puzzle from its last checkpoint. Level 2 checkpoints at the Scale Room, and Level 5 checkpoints at each platform. Temple levels checkpoint at each new room or trial.
- In the temple, traps send you back to the last checkpoint. Offerings and stones you have already found stay found, and offerings you have placed stay placed.
- A stone block pushed into a corner cannot be pulled back; **R** puts every block back where it started.
- Falling into the void returns you to the last checkpoint automatically.
- A cube, core or block that falls out of the world returns to where it started.
- The Level 3 core is recalled to its cradle if it lands somewhere you can't reach.
- Doors never close on you or on a cube.

---

## Interface and settings

- **Main menu:** Play / Continue, Level Select, Settings, Credits.
- **HUD:** crosshair, interaction prompts, level name and objective, hints, a progress bar with one marker per level, the level timer, a gravity indicator in the gravity levels, and in the temple a tray showing which offerings you have found and placed. The HUD turns gold and jade in the temple.
- **Pause menu** (Esc): Resume, Restart Level, Controls, Settings, Main Menu.
- **Between the parts:** finishing level 5 shows your Part I times and leads into the temple.
- **Victory screen:** total completion time with a per-level breakdown for both parts, and a Replay button.
- **Settings:** master / music / effects volume, mute, look sensitivity, invert Y, field of view, graphics quality (Low / Medium / High), auto-show hints, head bob, touch controls (Auto / On / Off).

Progress, best times and settings are saved in `localStorage` under the key `impossibleRooms.save.v1`. **Settings → Reset Progress** clears levels and times but keeps your settings. Saves from before Part II existed keep their progress, and a finished Part I unlocks level 6.

---

## How the mechanics work

- **Gravity rotation.** Gravity always points along one of the six axes. The player keeps a "body frame" quaternion that maps world-up onto their current up. Movement, jumping and collision are all computed in that frame, so walking on walls is real movement, not a rotated camera. When gravity changes, the frame turns smoothly (a 180° change rolls the view over), and loose objects fall the new way too.
- **Collision.** The physics uses axis-aligned boxes with per-axis, sub-stepped movement, step-up onto low ledges, depenetration, and support for moving and rotating platforms. Rotating rooms turn in 90° steps, so their colliders stay axis-aligned.
- **Portals.** Each portal renders the view from its partner into a render target. The view is drawn from a virtual camera (`partner · rotY(π) · inverse(portal) · camera`) with an oblique near plane, so nothing behind the far portal appears. The player and objects that pass through are transformed by the same matrix: position, velocity and view direction all carry over. If a portal changes your orientation, your gravity follows.
- **Forced perspective.** Pieces of the bridge and the hallway symbols are moved along rays from a single viewpoint and scaled in proportion. From that spot they line up perfectly; from anywhere else they are scattered fragments. Locking the perspective pulls the bridge pieces back to their true positions, still lined up along the same rays.
- **Size illusion.** A held perception block keeps its *angular* size. Each frame the game pushes it as far along your view ray as it will fit, so look at a distant wall and it becomes enormous. Pressure plates check the block's real size.
- **Audio.** Everything you hear is synthesised with the Web Audio API: facility hum, footsteps, switches, doors, portals, gravity shifts, generative ambient music, completion stingers and the finale. The temple swaps the hum for wind, insects, frogs, dripping water, clay flutes and distant drums, plus grinding stone, darts, blades, fire and the boulder.

### In the temple

- **Offerings.** Relics float above altars under a pillar of light. Taking one adds it to the tray in the HUD; placing it into its niche (a gate, an altar, the World Tree) is permanent for that level.
- **Glyph dials.** Carved stone drums with one symbol per face. A golden pointer marks the face that counts. Numeral dials use Maya bar-and-dot numbers: a dot is one, a bar is five, a shell is zero.
- **Push blocks.** Carved blocks slide one step (2 m) away from you along the nearest axis, if the way is clear. They count as weight on pressure plates, you can climb onto them, and they fall into pits.
- **Light.** Beams travel along the floor grid. A mirror turns light 90° from its polished face and stops it at its stone back; a prism splits it both ways; jade eyes wake when light reaches them. The beam is retraced every frame, so pushing a mirror-block through a beam updates it live.
- **Traps.** Spikes, darts, pendulum blades, fire vents, crumbling floors, a falling ceiling and a boulder each define a lethal volume that is checked against the player's collision box every frame.
- **Architecture.** Temple rooms are built from corbel-vaulted walls and doorways, and their static stone is merged into one mesh per material to keep draw calls low. Foliage is drawn with instanced alpha cards.

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
6. Part II: temple entities (`Relic`, `OfferingShrine`, `GlyphDial`, `PushBlock`, `StoneLever`, `CrumbleTile`, `SpikeTrap`, `DartTrap`, `Pendulum`, `FlameJet`, `KillZone`, `BeamNetwork`, `SunMirror`, `BeamPrism`, `BeamReceiver`, `Boulder`, `RisingBlock`), the `TempleLevel` builder, then `Level6` … `Level10`
7. The menu backdrop (an impossible triangle that only closes from one viewpoint) and the `UI` controller
8. `TouchControls`: floating joystick, drag-to-look and on-screen buttons
9. `Game`: renderer, post-processing, main loop, state machine, input, holding/interaction, portal rendering and level flow

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

Design, code, procedural art and audio for this project. Rendering by [three.js](https://threejs.org) (MIT License, see `lib/THREE-LICENSE.txt`). Fonts: Orbitron, Rajdhani and Cinzel (SIL Open Font License) via Google Fonts. Part II draws on Maya architecture and lore: corbel vaults, the feathered serpent Kukulkan, bar-and-dot numerals and the five world directions.
