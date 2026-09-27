# هجولة (Hajwala)

An Arabic-localized browser drift/racing game built with JavaScript and three.js, running on crashcat physics. Originally ported from [Kenney's Starter Kit Racing](https://github.com/KenneyNL/Starter-Kit-Racing) (Godot), and since expanded with AI opponents, lap timing, a track editor, and an AR mode for Meta Quest passthrough.

[Play](https://3wasfnjd.github.io/hajwala/)

![Screenshot](screenshot.png)

## Features

- Web driving (keyboard/touch) with AI opponents and lap timing
- AR mode (Meta Quest passthrough): drive in your own room, or place a grabbable/scalable floating track or drift arena
- Custom vehicle color/text/flag, full lighting (headlights, hazards, high beam), realistic engine/impact/skid audio
- Built-in track editor (`editor.html`) for designing and sharing custom layouts

## Credits

- Original game assets by [Kenney](https://kenney.nl/) (CC0)
- Physics engine: [crashcat](https://github.com/isaac-mason/crashcat)
- Built with [Claude](https://claude.ai/) by ABODEN GAMES

## City mode (experimental)

Choose **WEB → المدينة**, or open [the city directly](https://3wasfnjd.github.io/hajwala/?mode=city).
The direct link starts with the existing Camry; select a different car from the regular menu,
or pass its existing vehicle key with `?mode=city&vehicle=vehicle-jeep`.

- Original compact night district: 36 buildings, connected streets, a continuous outer loop,
  and a central drift space.
- Reuses Hajwala's vehicles, controls, crashcat physics, headlights, sound, and handbrake.
- Static collision for buildings, raised sidewalks, posts, and the visible perimeter.
- Rear camera smoothly follows the car's heading, with matching touch steering and
  building obstruction handling; city tire marks fade after nine seconds.
- City module and generated textures are created only after choosing this mode.
- Repeated geometry is instanced by material; no new downloaded model or texture assets.

Threejs-Punk ([threejs-conference](https://github.com/ektogamat/threejs-conference))
inspired exploring a city mode, but **this prototype does not contain its city model,
textures, sounds, or shaders**. Its README explicitly excludes `public/` assets from
the code's MIT license, and the inspected model contains no licensing metadata.
Replacing the district with a licensed GLB can be done in `js/City.js`.
The city includes GPU rain and ground ripples, luminous neon signs, nearby street
lights, and animated wet-road reflections. A city-only HDR composer enables bloom;
the existing renderer's unsigned-byte buffer cannot apply `setEffects()` itself.
Mobile uses 1,200 rain streaks, 180 splash rings, six nearby lights, and a 256px
reflection target updated at most 24 times per simulation second. These are
rendering limits, not a measured device frame-rate guarantee.

The **City prototype checks** workflow exercises menu entry, lazy loading, driving,
ground contact, building/perimeter collision, camera obstruction, and mobile viewport
rendering. Its screenshots are test artifacts, not a measurement of real iPhone performance.
