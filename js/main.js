import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
// (RoomEnvironment import removed — replaced by buildARColorEnvironmentScene below.)
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, cylinder, MotionType } from 'crashcat';
import { Vehicle, MAX_SPEED } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, computeTrackPath, NPC_TRUCKS, TRACK_CELLS } from './Track.js';
import { updateRaceAIDrivers, updateFreeRoamAIDrivers } from './AIController.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { DriftMarks } from './DriftMarks.js';
import { GameAudio } from './Audio.js';
import { createFlag, createSaudiFlagDataUrl } from './Flag.js';
import { LapTimer } from './LapTimer.js';
import { ColorMapGLTFLoader } from './Loader.js';
import { ARManager } from './ARManager.js';


const renderer = new THREE.WebGLRenderer( { alpha: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
// Capped at 1.5 (not the raw devicePixelRatio, which hits 3+ on many phones/
// tablets) — every render-cost-scaling-with-pixel-count effect (bloom,
// lighting, post-processing) otherwise renders several times more pixels
// than the screen can even show, which is exactly what was showing up as
// low-end-mobile stutter.
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 1.5 ) );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true; // required so main.js can offer AR MODE; NORMAL mode is unaffected

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.02;
bloomPass.radius = 0.02;
bloomPass.threshold = 0.5;

renderer.setEffects( [ bloomPass ] );

document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );

// Background music — the game's only music now (the in-car radio/station
// switcher was removed). Plays quietly on a loop from the moment the
// person picks a mode, for the whole session, in every mode (NORMAL, AR
// track, AR arena).
const bgMusic = new Audio( 'audio/music.mp3' );
bgMusic.loop = true;
bgMusic.volume = 0.35;
function startBgMusic() {

	bgMusic.play().catch( ( e ) => console.warn( '[main] background music autoplay blocked:', e ) );

}
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const dirLight = new THREE.DirectionalLight( 0xffffff, 3 );
dirLight.position.set( 11.4, 15, -5.3 );
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 2 );
hemiLight.position.copy( dirLight.position )
scene.add( hemiLight );

// ─── AR environment map (image-based lighting) ─────────────
// Every vehicle/track material is a real PBR MeshStandardMaterial, but
// without scene.environment set there's nothing for a moderately smooth
// surface to reflect — direct lights alone read as flat/dull no matter
// how bright they are. Originally three.js's own built-in RoomEnvironment
// (a small procedural room scene), which fixed the flatness but — per
// feedback comparing against a reference game — still read noticeably
// less "real" than a proper photographed HDRI. The single biggest
// difference: RoomEnvironment's own walls/area-lights are all pure white
// (`emissive: 0xffffff`, no tint at all — see its source), so its
// reflections have directional variation but zero COLOR variation, which
// is exactly what a real environment (sky vs sunset vs bounce light) has
// plenty of. buildARColorEnvironmentScene() below is the same
// technique/shape (a box room + emissive "window" panels, fed into
// PMREMGenerator) but with warm/cool tinted lights instead of white ones,
// so reflections pick up real directional color. No external HDRI file
// to fetch/host — still pure code/geometry, same as before.
function buildARColorEnvironmentScene() {

	const envScene = new THREE.Scene();

	const geometry = new THREE.BoxGeometry();
	geometry.deleteAttribute( 'uv' );

	// Dark neutral room shell — reflections should pick up the lights
	// below, not a bright gray box.
	const room = new THREE.Mesh( geometry, new THREE.MeshStandardMaterial( { side: THREE.BackSide, color: 0x121216 } ) );
	room.scale.set( 32, 26, 26 );
	envScene.add( room );

	function panel( color, intensity, position, scale ) {

		const mat = new THREE.MeshLambertMaterial( { color: 0x000000, emissive: color, emissiveIntensity: intensity } );
		const mesh = new THREE.Mesh( geometry, mat );
		mesh.position.set( ...position );
		mesh.scale.set( ...scale );
		envScene.add( mesh );

	}

	// Warm "sunset" panel, one side — orange.
	panel( 0xffa550, 45, [ -15, 6, 0 ], [ 0.1, 7, 11 ] );
	// Cool "sky" panel, overhead — pale blue.
	panel( 0xbcd9ff, 55, [ 0, 18, 0 ], [ 15, 0.1, 15 ] );
	// Soft neutral fill, opposite side, dimmer than the sunset panel so
	// the warm/cool split actually reads instead of cancelling out.
	panel( 0xffffff, 14, [ 15, 5, -6 ], [ 0.1, 8, 10 ] );

	const sun = new THREE.PointLight( 0xfff2e0, 320, 26, 2 );
	sun.position.set( -5, 13, 5 );
	envScene.add( sun );

	return envScene;

}

let arEnvironmentTexture = null;
function ensureAREnvironment() {

	if ( ! arEnvironmentTexture ) {

		const pmremGenerator = new THREE.PMREMGenerator( renderer );
		arEnvironmentTexture = pmremGenerator.fromScene( buildARColorEnvironmentScene(), 0.04 ).texture;
		pmremGenerator.dispose();

	}

	scene.environment = arEnvironmentTexture;
	// Full-strength (1.0) reflections stacked on top of this scene's own
	// direct lights pushed AR exposure too high — colors were clipping
	// toward white under ACES tone mapping instead of looking richer.
	// Dialed back to a fraction so surfaces still pick up real
	// reflections/ambient tint without washing out saturation.
	// (0.4 → 0.22: cut again per follow-up feedback that it was still too bright.)
	scene.environmentIntensity = 0.22;

}

// Soft dark circular decal just above the ground, parented under the
// player's own car — reads as a grounded contact/AO shadow without being
// a real light-blocking shadow. At AR's close-up tabletop viewing
// distance a car with nothing under it reads as floating far more than
// it does in NORMAL mode's much larger, farther-off view. Purely an
// unlit radial-gradient texture, rotationally symmetric, so it doesn't
// matter that it inherits whatever yaw its parent has. AR-only — never
// called from NORMAL/web mode.
let arContactShadowTexture = null;
function addARContactShadow( parent, radius = 1.3 ) {

	if ( ! arContactShadowTexture ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = 128; canvas.height = 128;
		const ctx = canvas.getContext( '2d' );
		const grad = ctx.createRadialGradient( 64, 64, 0, 64, 64, 64 );
		grad.addColorStop( 0, 'rgba(0,0,0,0.55)' );
		grad.addColorStop( 0.7, 'rgba(0,0,0,0.28)' );
		grad.addColorStop( 1, 'rgba(0,0,0,0)' );
		ctx.fillStyle = grad;
		ctx.fillRect( 0, 0, 128, 128 );
		arContactShadowTexture = new THREE.CanvasTexture( canvas );

	}

	const mesh = new THREE.Mesh(
		new THREE.CircleGeometry( radius, 24 ),
		new THREE.MeshBasicMaterial( {
			map: arContactShadowTexture, transparent: true, depthWrite: false, toneMapped: false,
		} )
	);
	mesh.rotation.x = - Math.PI / 2;
	mesh.position.y = 0.02;
	parent.add( mesh );
	return mesh;

}


window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );

} );

const loader = new ColorMapGLTFLoader();

const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-black', 'vehicle-truck-red', 'vehicle-truck-purple',
	'vehicle-camry', 'vehicle-camaro',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
];

// Godot imports vehicle models at root_scale=0.5 — true for every
// vehicle-truck-* model (all sourced from the same Godot pipeline), but
// vehicle-camry/vehicle-camaro are real-world-scale sedans/muscle cars
// from a different source, not Godot, so that flat 0.5 doesn't apply to
// them. Calibrated by eye instead, targeting roughly the same in-game
// footprint as the existing truck (real length ≈ 1.4m post-scale) — a
// touch longer, since a sedan/muscle car reasonably is one. Any
// vehicle-* name not listed here still falls back to the 0.5 default.
const VEHICLE_SCALE_OVERRIDES = {
	'vehicle-camry': 0.33,
	'vehicle-camaro': 0.5,
};

// vehicle-camry.glb was authored front-to-back reversed relative to the
// game's forward convention (Vehicle.js drives/steers around local +Z as
// "forward") — its hood/grille face -Z, so without this it visually drove
// backwards-first (confirmed in-game, and matching the fact that framing
// its true front for the menu thumbnail needed the camera flipped 180°
// from the angle every other car uses). A flat yaw spin on load fixes it
// for driving, steering, AI, and the thumbnail/showcase camera all at
// once. Any vehicle-* name not listed here gets no correction.
const VEHICLE_YAW_OVERRIDES = {
	'vehicle-camry': Math.PI,
};

// vehicle-camry.glb's node names ship abbreviated (wheel_F_R, its child
// meshes wheel_F_R_tire_0/wheel_F_R_wheel_0, etc.) — Vehicle.js's init()
// matches nodes by substring ('front'/'back'/'left'/'right'/'wheel'), so
// as shipped: the abbreviated F/B never matches front/back (no visual
// front-wheel turn on steering), and the parent group PLUS both child
// meshes all separately contain "wheel", so all three land in the
// wheels[] spin array at once — the parent's own spin then compounds
// with each child's, spinning ~3× too fast. Renamed here at load time
// (never touches the source .glb): the parent group gets a name
// Vehicle.js actually matches, spelled out and unambiguous; the two
// child meshes are renamed to drop "wheel" entirely so they're excluded
// from wheels[] — they still move/spin correctly since their parent
// group does, just aren't independently double-counted.
function fixCamryVehicleNaming( scene ) {

	scene.traverse( ( child ) => {

		const n = child.name;
		if ( n === 'wheel_F_L' ) child.name = 'wheel-front-left';
		else if ( n === 'wheel_F_R' ) child.name = 'wheel-front-right';
		else if ( n === 'wheel_B_L' ) child.name = 'wheel-back-left';
		else if ( n === 'wheel_B_R' ) child.name = 'wheel-back-right';
		else if ( n.endsWith( '_tire_0' ) ) child.name = 'camry-tire-part';
		else if ( n.endsWith( '_wheel_0' ) ) child.name = 'camry-rim-part';

	} );

}

// Requested Camry paint color: "سماوي" (sky blue) / Deep Sky Blue.
const CAMRY_BODY_COLOR = 0x00bfff;

// vehicle-camry.glb's "body" mesh is textured with a real shaded paint
// bake (via the shared colormap.png atlas, see Loader.js's
// ColorMapGLTFLoader) — NOT a flat color swatch. Sampling it face-by-face
// confirmed a wide gradient from near-black (window glass, shadowed
// underbody, tire-well) up through mid-tone grays to a lit blue-gray on
// the panels, i.e. real per-pixel shading/AO baked in, and the window
// glass is literally part of this same mesh/material (there's no separate
// glass material at all).
// First attempt dropped the texture map and used a flat material.color —
// that recolored the ENTIRE mesh uniformly, including the windows, which
// is the bug reported (the glass turned sky blue along with the body).
// Fixed by keeping the map and MULTIPLYING it by a tint color instead
// (material.color with the map still applied): near-black pixels
// (windows, shadow) stay near-black after multiplying by anything, so
// the glass stays dark/tinted-looking exactly as before, while the
// lighter body-panel pixels shift toward the requested hue and keep
// their baked highlights/shading. The extra ×COLOR_BOOST multiplier
// compensates for the base paint texture being fairly dark to begin
// with (plain ×1 tinting looked muddy/underlit) — 1.8 was picked by
// rendering a few options side by side and comparing against the
// requested "سماوي"/Deep Sky Blue. Channels are clamped to 1 so it can't
// overshoot into invalid color values.
const CAMRY_BODY_COLOR_BOOST = 1.8;

function applyCamryBodyColor( scene, hexColor, boost ) {

	const target = new THREE.Color( hexColor );

	scene.traverse( ( child ) => {

		if ( child.isMesh && child.material && child.material.name === 'body' ) {

			child.material.color.setRGB(
				Math.min( 1, target.r * boost ),
				Math.min( 1, target.g * boost ),
				Math.min( 1, target.b * boost ),
			);
			child.material.needsUpdate = true;

		}

	} );

}

const models = {};

async function loadModels() {

	const promises = modelNames.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				if ( name === 'vehicle-camry' ) {

					fixCamryVehicleNaming( gltf.scene );
					applyCamryBodyColor( gltf.scene, CAMRY_BODY_COLOR, CAMRY_BODY_COLOR_BOOST );

				}

				const meshes = [];
				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						child.material.side = THREE.FrontSide;
						meshes.push( child );

					}

				} );

				let root = gltf.scene;

				if ( name.startsWith( 'vehicle-' ) ) {

					const scale = VEHICLE_SCALE_OVERRIDES[ name ] !== undefined ? VEHICLE_SCALE_OVERRIDES[ name ] : 0.5;
					const yaw = VEHICLE_YAW_OVERRIDES[ name ];

					// Every vehicle gets wrapped in an outer Group that
					// carries the whole-model scale (and, below, a
					// ground-alignment lift) while staying at identity
					// rotation itself. Any yaw correction lives on the
					// INNER gltf.scene, never on this outer wrapper —
					// addVehicleLights()/addVehicleFlag()/
					// addCustomTextDecals() all parent their add-ons
					// directly under the clone of models[name] (this
					// wrapper), using canonical "+Z = front" coordinates;
					// if the yaw lived on that same node, those
					// coordinates would get carried along with it too.
					// (Confirmed: that's exactly why, before this, the
					// Camry's headlights ended up at the back and its
					// flag at the front.)
					const wrapper = new THREE.Group();
					if ( yaw ) gltf.scene.rotation.y += yaw;
					wrapper.add( gltf.scene );
					wrapper.scale.setScalar( scale );

					// Ground alignment: vehicle-truck-*.glb (this
					// project's own Godot pipeline) all model their
					// wheel-bottom exactly at local y=0 — which is what
					// Vehicle.js's physics placement assumes (it sets
					// container.position.y straight from the physics
					// sphere's ground-contact height, with no per-model
					// offset). vehicle-camry.glb/vehicle-camaro.glb come
					// from a different, non-Godot source and don't share
					// that convention: measured, the Camry's own lowest
					// point sits about 0.14 units below its local origin
					// (pre-scale) — enough to visibly sink its wheels
					// into the floor once placed, most noticeable in AR's
					// track/arena mode viewed close-up. Lifting the
					// wrapper by exactly enough to bring the model's own
					// measured lowest point to y=0 fixes this in general,
					// for any current or future vehicle model, instead of
					// a per-model hand-tuned constant — a verified no-op
					// for the truck models, which already measure at 0.
					wrapper.updateMatrixWorld( true );
					const groundBox = new THREE.Box3().setFromObject( gltf.scene );
					wrapper.position.y = - groundBox.min.y;

					root = wrapper;

				}

				if ( meshes.length === 1 ) {

					const mesh = meshes[ 0 ];
					mesh.removeFromParent();
					models[ name ] = mesh;

				} else {

					models[ name ] = root;

				}

				// Stash the model key so every .clone() of models[name] (every
				// vehicle spawn site does exactly that) carries it forward —
				// Object3D.clone() deep-copies userData. Lets addVehicleLights()/
				// addVehicleFlag()/addCustomTextDecals() below pick the right
				// static add-on layout (TRUCK_LAYOUT/CAMRY_LAYOUT/CAMARO_LAYOUT)
				// for whichever vehicle it's actually decorating.
				if ( name.startsWith( 'vehicle-' ) ) models[ name ].userData.vehicleKey = name;

				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );

}

// ─── Mode selection menu ──────────────────────────────────
// Neither existing markup nor CSS is touched; this overlay is created
// entirely from main.js so index.html stays untouched too.

// Requests fullscreen on the whole page. Must be called synchronously
// inside a user-gesture handler (click) or the browser will silently
// refuse. Not all mobile browsers support this (notably iPhone Safari
// does not support Element.requestFullscreen at all) — fails silently
// there, the game still works fine, just not edge-to-edge.
function requestFullscreenSafe() {

	const el = document.documentElement;
	const request = el.requestFullscreen || el.webkitRequestFullscreen ||
		el.mozRequestFullScreen || el.msRequestFullscreen;

	if ( ! request ) return;

	try {

		const result = request.call( el );
		if ( result && result.catch ) result.catch( ( e ) => console.warn( 'Fullscreen request failed:', e ) );

	} catch ( e ) {

		console.warn( 'Fullscreen request failed:', e );

	}

}

function isFullscreenActive() {

	return !! ( document.fullscreenElement || document.webkitFullscreenElement ||
		document.mozFullScreenElement || document.msFullscreenElement );

}

function exitFullscreenSafe() {

	const exit = document.exitFullscreen || document.webkitExitFullscreen ||
		document.mozCancelFullScreen || document.msExitFullscreen;

	if ( ! exit ) return;

	try {

		const result = exit.call( document );
		if ( result && result.catch ) result.catch( ( e ) => console.warn( 'Fullscreen exit failed:', e ) );

	} catch ( e ) {

		console.warn( 'Fullscreen exit failed:', e );

	}

}

// Arms fullscreen to fire on the very first tap/click ANYWHERE on the
// page — as close to "fullscreen the instant the game opens" as a
// website is actually allowed to get. No browser permits requesting
// fullscreen with zero user interaction at all (a hard, universal
// security rule — every site is bound by it, not something specific to
// this game); the first genuine gesture is the earliest legal moment.
// Runs once, then removes itself — except it deliberately skips a tap on
// the AR entry button, since requestSession() there needs that exact
// click's own transient user-activation (see the comment on
// arEntryBtn's own listener below) and requesting fullscreen first would
// consume it and silently break entering AR. Fullscreen is moot for AR
// anyway — the XR session already takes over the whole display. If the
// very first tap happens to land on that button, this just waits for the
// next one instead of firing.
function armAutoFullscreen() {

	function trigger( e ) {

		if ( e.target.closest && e.target.closest( '.hw-ar-entry-btn' ) ) return;

		document.removeEventListener( 'pointerdown', trigger );
		requestFullscreenSafe();

	}

	document.addEventListener( 'pointerdown', trigger );

}

armAutoFullscreen();

function createModeMenu( { arAvailable } ) {

	return new Promise( ( resolve ) => {

		const style = document.createElement( 'style' );
		style.textContent = `
			#hajwalah-menu * { box-sizing: border-box; }
			#hajwalah-menu {
				position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
				background:
					linear-gradient(to bottom, rgba(6,4,14,0.55) 0%, rgba(6,4,14,0.1) 18%, rgba(6,4,14,0.0) 32%, rgba(6,4,14,0.08) 55%, rgba(6,4,14,0.8) 72%, rgba(4,3,10,0.97) 100%),
					url('images/menu/menu-bg.jpg') center/cover no-repeat, #0a0a12;
				font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 22px 16px; overflow-y: auto;
			}
			#hajwalah-menu .hw-wrap {
				display: flex; flex-direction: column; align-items: center;
				width: 100%; max-width: 400px; min-height: min(760px, 94vh);
			}
			#hajwalah-menu .hw-brand { text-align: center; }
			#hajwalah-menu .hw-brand img {
				width: 68px; height: 68px; border-radius: 16px; object-fit: cover;
				box-shadow: 0 0 20px rgba(139,95,191,0.55);
			}
			#hajwalah-menu .hw-title-name {
				text-align: center; margin-top: 8px; font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 0.5px;
				text-shadow: 0 0 18px rgba(120,180,255,0.55), 0 2px 6px rgba(0,0,0,0.6);
			}
			#hajwalah-menu .hw-icon-panel {
				margin: 14px auto 0; width: 100%; display: flex; gap: 2px;
				border-radius: 20px; overflow: hidden;
				background: rgba(14,11,24,0.6); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(6px);
			}
			#hajwalah-menu .hw-icon-slot { position: relative; flex: 1; }
			#hajwalah-menu .hw-icon-slot .hw-mode-card {
				width: 100%; height: 117px; padding: 0;
				display: flex; align-items: center; justify-content: center;
			}
			#hajwalah-menu .hw-icon-slot .hw-mode-card img { margin-bottom: 0; }
			#hajwalah-menu .hw-flag-clear-badge {
				position: absolute; top: -6px; left: -6px; width: 18px; height: 18px; border-radius: 50%;
				background: #ff5a5a; color: #fff; font-size: 12px; line-height: 17px; text-align: center;
				border: 1px solid rgba(255,255,255,0.5); padding: 0; cursor: pointer; display: block;
			}
			#hajwalah-menu .hw-flag-clear-badge.hidden { display: none; }
			#hajwalah-menu .hw-name-badge {
				position: absolute; top: -4px; left: -4px; width: 12px; height: 12px; border-radius: 50%;
				background: #5B8CFF; border: 1px solid rgba(255,255,255,0.6); display: none; pointer-events: none;
			}
			#hajwalah-menu .hw-name-badge.shown { display: block; }
			#hajwalah-menu .hw-bottom-panel {
				margin-top: auto; width: 100%; border-radius: 20px; overflow: hidden;
				background: rgba(14,11,24,0.6); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(6px);
			}
			#hajwalah-menu .hw-step.hidden { display: none; }
			#hajwalah-menu .hw-car-showcase {
				padding: 10px 10px 8px;
				background: radial-gradient(circle at 50% 25%, rgba(80,60,140,0.3), rgba(10,8,20,0.1) 75%);
				position: relative;
			}
			#hajwalah-menu .hw-car-stage { position: relative; height: 92px; display: flex; align-items: center; justify-content: center; }
			#hajwalah-menu .hw-car-stage .hw-glow {
				position: absolute; width: 110px; height: 26px; bottom: 4px; left: 50%; transform: translateX(-50%);
				background: radial-gradient(ellipse at center, rgba(180,140,255,0.42), transparent 70%); filter: blur(2px);
			}
			#hajwalah-menu .hw-car-stage img {
				position: relative; width: 112px; height: 112px; object-fit: contain;
				filter: drop-shadow(0 8px 10px rgba(0,0,0,0.5));
			}
			#hajwalah-menu .hw-car-nav {
				position: absolute; top: 50%; transform: translateY(-50%);
				width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.1);
				color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px;
				border: 1px solid rgba(255,255,255,0.18); cursor: pointer; user-select: none;
			}
			#hajwalah-menu .hw-car-nav.prev { right: 4px; }
			#hajwalah-menu .hw-car-nav.next { left: 4px; }
			#hajwalah-menu .hw-car-name { text-align: center; color: #fff; font-size: 13.5px; font-weight: 700; margin-top: 2px; }
			#hajwalah-menu .hw-car-dots { display: flex; justify-content: center; gap: 7px; margin-top: 6px; padding-bottom: 2px; }
			#hajwalah-menu .hw-car-dots span {
				width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.25);
				cursor: pointer; display: block;
			}
			#hajwalah-menu .hw-car-dots span.active { border-color: #fff; box-shadow: 0 0 8px rgba(255,255,255,0.55); }
			#hajwalah-menu .hw-modes { display: flex; gap: 2px; border-top: 1px solid rgba(255,255,255,0.1); }
			#hajwalah-menu .hw-mode-card {
				flex: 1; position: relative; padding: 16px 8px 14px; text-align: center; cursor: pointer;
				overflow: hidden; border: none; color: #fff;
				background: linear-gradient(160deg, rgba(30,20,55,0.35), rgba(10,8,20,0.42));
				box-shadow: 0 0 0 1px rgba(255,255,255,0.14) inset;
			}
			#hajwalah-menu .hw-mode-card.web { box-shadow: 0 0 0 1px rgba(79,216,232,0.25) inset; }
			#hajwalah-menu .hw-mode-card.vr { box-shadow: 0 0 0 1px rgba(180,95,232,0.3) inset; }
			#hajwalah-menu .hw-mode-card:disabled { opacity: 0.45; cursor: not-allowed; }
			#hajwalah-menu .hw-mode-card img {
				width: 48px; height: 48px; object-fit: contain; margin-bottom: 6px;
				filter: drop-shadow(0 0 1px rgba(255,255,255,0.6)) drop-shadow(0 0 4px rgba(140,180,255,0.5));
			}
			#hajwalah-menu .hw-mode-card svg { width: 48px; height: 48px; margin-bottom: 6px; }
			#hajwalah-menu .hw-m-label { font-size: 14px; font-weight: 800; }
			#hajwalah-menu .hw-m-sub { font-size: 9.5px; color: #b7bfe0; margin-top: 2px; }
			#hajwalah-menu .hw-back-link {
				display: block; text-align: center; padding: 9px 0 3px; color: #a79fc4; font-size: 12px; cursor: pointer;
			}
			#hajwalah-menu .hw-footer-text {
				text-align: center; margin-top: 14px; padding: 4px 0 2px; color: #e8e4f2; font-size: 12px;
				text-shadow: 0 1px 4px rgba(0,0,0,0.8);
			}
			#hajwalah-menu .hw-footer-text a { color: #e8e4f2; text-decoration: none; }
			#hajwalah-menu .hw-footer-text a:hover { text-decoration: underline; }
			#hajwalah-menu .hw-footer-text span { margin: 0 6px; color: rgba(255,255,255,0.4); }

			#hw-name-popup-overlay {
				position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center;
				background: rgba(5,5,10,0.75); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px;
			}
			#hw-name-popup-overlay .hwn-card {
				max-width: 320px; width: 100%;
				background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
				border: 1px solid rgba(139,95,191,0.4); border-radius: 18px; padding: 22px 20px;
			}
			#hw-name-popup-overlay .hwn-label { color: #b9b3cc; font-size: 12.5px; text-align: center; margin-bottom: 10px; }
			#hw-name-popup-overlay input[type=text] {
				width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
				background: rgba(255,255,255,0.06); color: #fff; font-size: 15px; text-align: center; outline: none; margin-bottom: 14px;
			}
			#hw-name-popup-overlay .hwn-save {
				display: block; width: 100%; padding: 12px; border: none; border-radius: 999px;
				background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; font-size: 14.5px; font-weight: 700; cursor: pointer;
			}
		`;

		const menu = document.createElement( 'div' );
		menu.id = 'hajwalah-menu';
		menu.dir = 'rtl';

		const VEHICLE_OPTIONS = [
			{ key: 'vehicle-truck-black', label: 'اف جي', thumb: 'images/menu/thumb-black.png' },
			{ key: 'vehicle-camry', label: 'كامري', thumb: 'images/menu/thumb-camry.png' },
			{ key: 'vehicle-camaro', label: 'كامارو', thumb: 'images/menu/thumb-camaro.png' },
			{ key: 'vehicle-truck-red', label: 'أحمر', thumb: 'images/menu/thumb-red.png' },
			{ key: 'vehicle-truck-yellow', label: 'أصفر', thumb: 'images/menu/thumb-yellow.png' },
			{ key: 'vehicle-truck-green', label: 'أخضر', thumb: 'images/menu/thumb-green.png' },
		];
		let selectedVehicleIndex = 0; // black ("اف جي") is the default car — back at index 0 after the reorder
		let customTextValue = '';
		let flagImageDataUrl = null;

		menu.innerHTML = `
			<div class="hw-wrap">
				<div class="hw-brand"><img src="images/menu/logo.png" alt="Aboden Games" /></div>
				<div class="hw-title-name">هجولة</div>

				<div class="hw-icon-panel">
					<div class="hw-icon-slot">
						<button type="button" class="hw-mode-card hw-flag-icon-btn" title="صورة العلم الخلفي">
							<img src="images/menu/icon-flag.png" alt="العلم" />
						</button>
						<button type="button" class="hw-flag-clear-badge hidden" title="إزالة الصورة">×</button>
					</div>
					<div class="hw-icon-slot">
						<button type="button" class="hw-mode-card hw-name-icon-btn" title="نص مخصص">
							<img src="images/menu/icon-name.png" alt="الاسم" />
						</button>
						<span class="hw-name-badge"></span>
					</div>
				</div>
				<input type="file" accept="image/*" class="hw-flag-input" hidden />

				<div class="hw-bottom-panel">
					<div class="hw-step hw-step-top">
						<div class="hw-car-showcase">
							<div class="hw-car-nav prev">‹</div>
							<div class="hw-car-nav next">›</div>
							<div class="hw-car-stage">
								<div class="hw-glow"></div>
								<img class="hw-car-img" src="" alt="" />
							</div>
							<div class="hw-car-name"></div>
							<div class="hw-car-dots"></div>
						</div>
						<div class="hw-modes">
							<button class="hw-mode-card vr hw-ar-entry-btn" ${ arAvailable ? '' : 'disabled' }>
								<img src="images/menu/icon-vr.png" alt="VR" />
								<div class="hw-m-label">VR</div>
								<div class="hw-m-sub">${ arAvailable ? 'Meta Quest 3' : 'غير متاح على هذا الجهاز' }</div>
							</button>
							<button class="hw-mode-card web hw-web-btn">
								<img src="images/menu/icon-web.png" alt="WEB" />
								<div class="hw-m-label">WEB</div>
								<div class="hw-m-sub">لمس أو كيبورد</div>
							</button>
						</div>
					</div>

					<div class="hw-step hw-step-web hidden">
						<div class="hw-modes">
							<button class="hw-mode-card web hw-web-track-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#5B8CFF" stroke-width="1.6">
									<circle cx="12" cy="12" r="9"/>
									<circle cx="12" cy="12" r="2.4" fill="#5B8CFF" stroke="none"/>
									<path d="M12 5v4.6M6.2 15.5l3.6-2.2M17.8 15.5l-3.6-2.2"/>
								</svg>
								<div class="hw-m-label">المضمار</div>
								<div class="hw-m-sub">سباق كلاسيكي</div>
							</button>
							<button class="hw-mode-card hw-web-free-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
									<path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" />
								</svg>
								<div class="hw-m-label">الوضع الحر</div>
								<div class="hw-m-sub">تحكم حر بدون مضمار</div>
							</button>
						</div>
						<a href="#" class="hw-back-link hw-back-link-web">‹ رجوع</a>
					</div>
				</div>

				<div class="hw-footer-text">
					<a href="#" class="hw-features-link">نبذة عن اللعبة</a>
					<span>—</span>
					<a href="#" class="hw-controls-link">التحكم</a>
				</div>
			</div>
		`;

		document.head.appendChild( style );

		// ─── Car showcase (prev/next + dots cycling through VEHICLE_OPTIONS) ───
		const carImg = menu.querySelector( '.hw-car-img' );
		const carNameEl = menu.querySelector( '.hw-car-name' );
		const carDotsRow = menu.querySelector( '.hw-car-dots' );
		const carDots = [];

		VEHICLE_OPTIONS.forEach( ( opt, i ) => {

			const dot = document.createElement( 'span' );
			dot.className = `hw-car-dot c-${ i }`;
			dot.style.background = { 'vehicle-truck-black': '#171717', 'vehicle-truck-red': '#e03b3b', 'vehicle-truck-yellow': '#e8c23b', 'vehicle-truck-green': '#3ba85c', 'vehicle-camry': '#2b3a55', 'vehicle-camaro': '#141414' }[ opt.key ] || '#666';
			dot.addEventListener( 'click', () => {

				selectedVehicleIndex = i;
				refreshCarDisplay();

			} );
			carDots.push( dot );
			carDotsRow.appendChild( dot );

		} );

		function refreshCarDisplay() {

			const opt = VEHICLE_OPTIONS[ selectedVehicleIndex ];
			carImg.src = opt.thumb;
			carImg.alt = opt.label;
			carNameEl.textContent = opt.label;
			carDots.forEach( ( d, i ) => d.classList.toggle( 'active', i === selectedVehicleIndex ) );

		}

		refreshCarDisplay();

		menu.querySelector( '.hw-car-nav.prev' ).addEventListener( 'click', () => {

			selectedVehicleIndex = ( selectedVehicleIndex - 1 + VEHICLE_OPTIONS.length ) % VEHICLE_OPTIONS.length;
			refreshCarDisplay();

		} );
		menu.querySelector( '.hw-car-nav.next' ).addEventListener( 'click', () => {

			selectedVehicleIndex = ( selectedVehicleIndex + 1 ) % VEHICLE_OPTIONS.length;
			refreshCarDisplay();

		} );

		// ─── Flag image icon (file picker, read locally as a data URL) ───
		// Same FileReader approach as before — no server/upload involved,
		// works fully offline, and the resulting data: URL is exactly what
		// THREE.TextureLoader/createFlag() already accepts as an imageUrl.
		const flagIconBtn = menu.querySelector( '.hw-flag-icon-btn' );
		const flagInput = menu.querySelector( '.hw-flag-input' );
		const flagClearBadge = menu.querySelector( '.hw-flag-clear-badge' );

		flagIconBtn.addEventListener( 'click', () => flagInput.click() );

		flagInput.addEventListener( 'change', () => {

			const file = flagInput.files && flagInput.files[ 0 ];
			if ( ! file ) return;

			const reader = new FileReader();
			reader.onload = () => {

				flagImageDataUrl = reader.result;
				flagClearBadge.classList.remove( 'hidden' );

			};
			reader.readAsDataURL( file );

		} );

		flagClearBadge.addEventListener( 'click', ( e ) => {

			e.stopPropagation();
			flagImageDataUrl = null;
			flagInput.value = '';
			flagClearBadge.classList.add( 'hidden' );

		} );

		// ─── Name icon (opens a small popup with the custom-text field) ───
		// The compact icon-box design has no room for a permanently visible
		// text field, so the input only exists inside this on-demand popup.
		// customTextValue is kept in sync on every keystroke (not just on
		// "save"), so closing the popup any way (save button, backdrop tap)
		// never loses what was typed.
		const nameIconBtn = menu.querySelector( '.hw-name-icon-btn' );
		const nameBadge = menu.querySelector( '.hw-name-badge' );

		function openNamePopup() {

			const overlay = document.createElement( 'div' );
			overlay.id = 'hw-name-popup-overlay';
			overlay.dir = 'rtl';
			overlay.innerHTML = `
				<div class="hwn-card">
					<div class="hwn-label">نص مخصص (الزجاج الأمامي والباب الخلفي) — اختياري</div>
					<input type="text" maxlength="12" placeholder="مثال: عتابه" />
					<button type="button" class="hwn-save">تم</button>
				</div>
			`;

			const input = overlay.querySelector( 'input' );
			input.value = customTextValue;
			input.addEventListener( 'input', () => { customTextValue = input.value; nameBadge.classList.toggle( 'shown', customTextValue.trim() !== '' ); } );
			input.addEventListener( 'keydown', ( e ) => { if ( e.key === 'Enter' ) overlay.remove(); } );

			overlay.querySelector( '.hwn-save' ).addEventListener( 'click', () => overlay.remove() );
			overlay.addEventListener( 'click', ( e ) => { if ( e.target === overlay ) overlay.remove(); } );

			document.body.appendChild( overlay );
			input.focus();

		}

		nameIconBtn.addEventListener( 'click', openNamePopup );

		// ─── Mode navigation (WEB reveals track/free-roam choice; VR enters
		// the AR session directly) — same two-step flow as before, just
		// reskinned into the new panel. ───
		const webBtn = menu.querySelector( '.hw-web-btn' );
		const arEntryBtn = menu.querySelector( '.hw-ar-entry-btn' );
		const stepTop = menu.querySelector( '.hw-step-top' );
		const stepWeb = menu.querySelector( '.hw-step-web' );
		const webTrackBtn = menu.querySelector( '.hw-web-track-btn' );
		const webFreeBtn = menu.querySelector( '.hw-web-free-btn' );
		const backLinkWeb = menu.querySelector( '.hw-back-link-web' );

		webBtn.addEventListener( 'click', () => {

			stepTop.classList.add( 'hidden' );
			stepWeb.classList.remove( 'hidden' );

		} );

		backLinkWeb.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			stepWeb.classList.add( 'hidden' );
			stepTop.classList.remove( 'hidden' );

		} );

		function chooseWeb( freeRoam ) {

			requestFullscreenSafe();
			startBgMusic();
			menu.remove();
			resolve( {
				choice: 'normal', customText: customTextValue.trim(), freeRoam,
				vehicleKey: VEHICLE_OPTIONS[ selectedVehicleIndex ].key, flagImage: flagImageDataUrl,
			} );

		}

		webTrackBtn.addEventListener( 'click', () => chooseWeb( false ) );
		webFreeBtn.addEventListener( 'click', () => chooseWeb( true ) );

		// AR now goes straight into the session — which of the three AR
		// experiences (room-drive / floating track / floating arena) is
		// chosen from a floating 3D menu inside the headset itself
		// instead of a flat pre-session screen. hit-test is requested
		// up front for all three even though only room-drive currently
		// uses it, since the person hasn't picked a mode yet at this
		// point and re-requesting a session with different features
		// after the fact isn't practical.
		arEntryBtn.addEventListener( 'click', () => {

			if ( arEntryBtn.disabled ) return;

			// No requestFullscreenSafe() here on purpose: it would consume
			// the click's transient user-activation, and requestSession()
			// below needs that same activation. AR sessions take over the
			// whole display anyway, so it's moot.
			//
			// requestSession() itself is also started HERE, synchronously,
			// rather than later inside startARWithFloatingMenu() — some
			// browsers only honor user-activation for a call made directly
			// in the event handler, not after several chained await hops.
			// The resulting promise is handed off and awaited downstream.
			// 'dom-overlay' (optional — ignored harmlessly if unsupported)
			// is what lets the game's existing 2D DOM HUD (lap timer,
			// race-results card, etc.) actually render on top of the AR
			// passthrough view at all; without it every DOM overlay in the
			// game is silently invisible for the whole AR session, which is
			// why the lap timer previously never appeared once inside AR.
			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor', 'hit-test' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection', 'dom-overlay' ],
				domOverlay: { root: document.body },
			} );
			startBgMusic();

			menu.remove();
			resolve( {
				choice: 'ar', customText: customTextValue.trim(),
				vehicleKey: VEHICLE_OPTIONS[ selectedVehicleIndex ].key, flagImage: flagImageDataUrl, sessionPromise,
			} );

		} );

		const featuresLink = menu.querySelector( '.hw-features-link' );
		featuresLink.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			showFeaturesModal();

		} );

		const controlsLink = menu.querySelector( '.hw-controls-link' );
		controlsLink.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			showControlsModal();

		} );

		document.body.appendChild( menu );

		// Background music starts on the very first interaction with the
		// menu page itself (not just after picking a mode) — browsers
		// block audio autoplay without a genuine user gesture, so this
		// is the earliest point it can reliably start.
		menu.addEventListener( 'pointerdown', startBgMusic, { once: true } );
		menu.addEventListener( 'keydown', startBgMusic, { once: true } );

	} );

}

// ─── "What's new" features modal ───────────────────────────
// Summarizes the major additions built on top of the original starter
// kit — opened from a link in the main menu's footer.

function showFeaturesModal() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-features-overlay {
			position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.75); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px;
		}
		#hw-features-overlay .hwf-card {
			max-width: 460px; width: 100%; max-height: 82vh; overflow-y: auto;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); border-radius: 20px; padding: 26px 22px;
			box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-features-overlay .hwf-title {
			font-size: 26px; font-weight: 800; text-align: center;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
			margin-bottom: 4px;
		}
		#hw-features-overlay .hwf-sub { color: #9a94b0; font-size: 12px; text-align: center; margin-bottom: 20px; }
		#hw-features-overlay .hwf-row {
			display: flex; align-items: flex-start; gap: 12px; padding: 12px 0;
			border-top: 1px solid rgba(255,255,255,0.08);
		}
		#hw-features-overlay .hwf-row:first-of-type { border-top: none; }
		#hw-features-overlay .hwf-icon { font-size: 20px; line-height: 1.3; flex-shrink: 0; width: 26px; text-align: center; }
		#hw-features-overlay .hwf-label { color: #fff; font-size: 14.5px; font-weight: 600; margin-bottom: 2px; }
		#hw-features-overlay .hwf-desc { color: #a79fc4; font-size: 12.5px; line-height: 1.5; }
		#hw-features-overlay .hwf-close {
			display: block; width: 100%; margin-top: 20px; padding: 13px; border: none; border-radius: 999px;
			background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
		}
		#hw-features-overlay .hwf-about {
			background: rgba(139,95,191,0.1); border: 1px solid rgba(139,95,191,0.3); border-radius: 12px;
			padding: 12px 14px; margin-bottom: 18px; color: #cfc9e0; font-size: 12.5px; line-height: 1.7; text-align: center;
		}
		#hw-features-overlay .hwf-about b { color: #fff; }
	`;

	const FEATURES = [
		{ icon: '🕶️', label: 'واقع افتراضي (AR)', desc: 'داخل غرفتك، Quest 3' },
		{ icon: '🌍', label: 'وضع حر', desc: 'تفحيط بدون مضمار' },
		{ icon: '🏁', label: 'سباق ضد AI', desc: '3 لفات + عدّاد وقت' },
		{ icon: '🚙', label: 'تخصيص السيارة', desc: 'لون، نص، علم' },
		{ icon: '💡', label: 'إضاءة كاملة', desc: 'أمامية، خلفية، طوارئ' },
		{ icon: '🔊', label: 'صوت واقعي', desc: 'محرك، بوق، ارتطام' },
		{ icon: '🎵', label: 'موسيقى خلفية', desc: 'تشتغل طول اللعب' },
		{ icon: '🛠️', label: 'محرر مضامير', desc: 'صمم مضمارك، ويب و AR' },
		{ icon: '📱', label: 'كل الأجهزة', desc: 'كيبورد، لمس، يد Quest' },
	];

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-features-overlay';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="hwf-card">
			<div class="hwf-title">هجولة</div>
			<div class="hwf-sub">مميزات اللعبة</div>
			<div class="hwf-about">
				طوّر هذه اللعبة <b>ABODEN GAMES</b> بمساعدة <b>Claude</b> من Anthropic.
				<br/>تيك توك: <b>@3wasf.njd</b> — جميع الحقوق محفوظة.
				<br/>المشروع الأصلي: <b>Kenney</b> (تصميم) · <b>mrdoob</b> (Three.js) · <b>crashcat</b> (فيزياء).
			</div>
			${ FEATURES.map( ( f ) => `
				<div class="hwf-row">
					<div class="hwf-icon">${ f.icon }</div>
					<div>
						<div class="hwf-label">${ f.label }</div>
						<div class="hwf-desc">${ f.desc }</div>
					</div>
				</div>
			` ).join( '' ) }
			<button class="hwf-close">رجوع</button>
		</div>
	`;

	document.head.appendChild( style );
	document.body.appendChild( overlay );

	overlay.querySelector( '.hwf-close' ).addEventListener( 'click', () => overlay.remove() );
	overlay.addEventListener( 'click', ( e ) => { if ( e.target === overlay ) overlay.remove(); } );

}

// ─── Controls guide ─────────────────────────────────────────
// Every binding here is read straight from the actual input code
// (Controls.js's keyboard/gamepad section, main.js's own key checks,
// and ARManager.js's controller-button map) — not re-derived/guessed,
// so this stays accurate as those change. Grouped by input method since
// a given session only ever uses one at a time; each row is a key/
// button badge + a 2-4 word action, no long sentences (same short style
// as the features modal).
function showControlsModal() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-controls-overlay {
			position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.75); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px;
		}
		#hw-controls-overlay .hwc-card {
			max-width: 460px; width: 100%; max-height: 82vh; overflow-y: auto;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); border-radius: 20px; padding: 26px 22px;
			box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-controls-overlay .hwc-title {
			font-size: 26px; font-weight: 800; text-align: center;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
			margin-bottom: 4px;
		}
		#hw-controls-overlay .hwc-sub { color: #9a94b0; font-size: 12px; text-align: center; margin-bottom: 18px; }
		#hw-controls-overlay .hwc-group { margin-bottom: 16px; }
		#hw-controls-overlay .hwc-group-title {
			display: flex; align-items: center; gap: 8px; color: #cfc9e0; font-size: 13.5px;
			font-weight: 700; margin-bottom: 8px;
		}
		#hw-controls-overlay .hwc-row {
			display: flex; align-items: center; gap: 10px; padding: 7px 0;
			border-top: 1px solid rgba(255,255,255,0.07);
		}
		#hw-controls-overlay .hwc-group .hwc-row:first-of-type { border-top: none; }
		#hw-controls-overlay .hwc-key {
			flex-shrink: 0; min-width: 44px; text-align: center; padding: 3px 8px; border-radius: 7px;
			background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
			color: #fff; font-size: 11.5px; font-weight: 700; font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
		}
		#hw-controls-overlay .hwc-action { color: #a79fc4; font-size: 12.5px; }
		#hw-controls-overlay .hwc-close {
			display: block; width: 100%; margin-top: 6px; padding: 13px; border: none; border-radius: 999px;
			background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
		}
	`;

	const GROUPS = [
		{
			icon: '⌨️', title: 'لوحة المفاتيح', rows: [
				[ 'WASD', 'قيادة' ],
				[ 'B', 'فرملة يد' ],
				[ 'مسافة', 'بوق' ],
				[ 'L', 'أضواء أمامية' ],
				[ 'H', 'طوارئ' ],
				[ 'N (مسّك)', 'إضاءة عالية' ],
			]
		},
		{
			icon: '👆', title: 'اللمس (جوال)', rows: [
				[ 'سحب', 'قيادة' ],
				[ '💡 ⚠️', 'أضواء / طوارئ' ],
				[ '🔆 (مسّك)', 'إضاءة عالية' ],
				[ '⛶', 'ملء الشاشة' ],
				[ '🔊', 'إيقاف/تشغيل الموسيقى' ],
			]
		},
		{
			icon: '🎮', title: 'يد تحكم (Gamepad)', rows: [
				[ 'العصا اليسرى', 'قيادة يمين/يسار' ],
				[ 'RT / LT', 'دفع / فرملة' ],
			]
		},
		{
			icon: '🕶️', title: 'يد Quest (وضع AR)', rows: [
				[ 'عصا يمين', 'قيادة يمين/يسار' ],
				[ 'زناد يمين', 'دفع' ],
				[ 'زناد يسار', 'فرملة/رجوع' ],
				[ 'عصا يسار', 'تكبير/تصغير السيارة' ],
				[ 'ضغط عصا يمين', 'أضواء أمامية' ],
				[ 'A يمين', 'طوارئ' ],
				[ 'B يمين (مسّك)', 'إضاءة عالية' ],
				[ 'قبضة يسار (مسّك)', 'بوق' ],
				[ 'X يسار (مسّك)', 'فرملة يد' ],
				[ 'Y يسار', 'كتم/تشغيل الموسيقى' ],
			]
		},
	];

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-controls-overlay';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="hwc-card">
			<div class="hwc-title">التحكم</div>
			<div class="hwc-sub">حسب طريقة اللعب اللي تستخدمها</div>
			${ GROUPS.map( ( g ) => `
				<div class="hwc-group">
					<div class="hwc-group-title"><span>${ g.icon }</span><span>${ g.title }</span></div>
					${ g.rows.map( ( [ key, action ] ) => `
						<div class="hwc-row">
							<div class="hwc-key">${ key }</div>
							<div class="hwc-action">${ action }</div>
						</div>
					` ).join( '' ) }
				</div>
			` ).join( '' ) }
			<button class="hwc-close">رجوع</button>
		</div>
	`;

	document.head.appendChild( style );
	document.body.appendChild( overlay );

	overlay.querySelector( '.hwc-close' ).addEventListener( 'click', () => overlay.remove() );
	overlay.addEventListener( 'click', ( e ) => { if ( e.target === overlay ) overlay.remove(); } );

}

// Soft radial-gradient glow texture (opaque center fading fully
// transparent at the edge) — used for the headlight halo so it looks
// like a real glow instead of a flat disc sitting on top of the lens.
function createGlowTexture( color ) {

	const size = 128;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	const grad = ctx.createRadialGradient( size / 2, size / 2, 0, size / 2, size / 2, size / 2 );
	grad.addColorStop( 0, `rgba(${ color }, 0.9)` );
	grad.addColorStop( 0.5, `rgba(${ color }, 0.35)` );
	grad.addColorStop( 1, `rgba(${ color }, 0)` );
	ctx.fillStyle = grad;
	ctx.fillRect( 0, 0, size, size );

	return new THREE.CanvasTexture( canvas );

}

// ─── Free-roam circuit environment (asphalt + grandstands) ──

function createAsphaltTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	// Matches the real track's own asphalt tone (0x3a3a40 — the same
	// value the AR floating arena already samples from the track's
	// shared palette texture) instead of the previous near-black
	// #232326, which read visibly darker/flatter than the actual race
	// track surface.
	ctx.fillStyle = '#3a3a40';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 1400; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = 20 + Math.random() * 30;
		ctx.fillStyle = `rgba(${ v },${ v },${ v + 2 },${ 0.25 + Math.random() * 0.3 })`;
		ctx.fillRect( x, y, 1.4, 1.4 );

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Subtle grid of dashed lane-marking lines — gives visual reference
// points scattered across the open paved area, loosely evoking street
// lane markings (useful even with the barrier/stand dressing, since the
// middle of a large arena can still feel empty without them).

function createSandTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#c9a877';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 2200; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = Math.random();
		const shade = v < 0.5 ? `rgba(150,120,80,${ 0.08 + Math.random() * 0.12 })` : `rgba(230,205,160,${ 0.08 + Math.random() * 0.15 })`;
		ctx.fillStyle = shade;
		ctx.fillRect( x, y, 1.6, 1.6 );

	}

	// Faint wind-ripple streaks
	ctx.strokeStyle = 'rgba(120,95,60,0.08)';
	ctx.lineWidth = 2;
	for ( let i = 0; i < 18; i ++ ) {

		const y = Math.random() * size;
		ctx.beginPath();
		ctx.moveTo( 0, y );
		ctx.bezierCurveTo( size * 0.3, y + ( Math.random() - 0.5 ) * 20, size * 0.7, y + ( Math.random() - 0.5 ) * 20, size, y );
		ctx.stroke();

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Large, non-repeating overlay of burnout circles and drift streaks laid
// once across the whole paved arena — a tiled texture would look
// obviously patterned at this scale, so this is drawn once at full size.
function createSkidMarksTexture( worldSize ) {

	const size = 1024;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );

	const toPx = ( w ) => ( w / worldSize + 0.5 ) * size;

	ctx.strokeStyle = 'rgba(10,10,12,0.35)';
	ctx.lineCap = 'round';

	// Burnout circles: paired concentric-ish rings with a slightly wobbly
	// radius, like a real donut/burnout mark.
	const circleCount = 7;
	for ( let c = 0; c < circleCount; c ++ ) {

		const cx = toPx( ( Math.random() - 0.5 ) * worldSize * 0.75 );
		const cy = toPx( ( Math.random() - 0.5 ) * worldSize * 0.75 );
		const r = size * ( 0.02 + Math.random() * 0.035 );

		for ( const offset of [ -3, 3 ] ) {

			ctx.lineWidth = 2.5 + Math.random() * 1.5;
			ctx.beginPath();
			const segs = 48;
			for ( let i = 0; i <= segs; i ++ ) {

				const a = ( i / segs ) * Math.PI * 2;
				const wob = Math.sin( a * 5 + c ) * r * 0.05;
				const px = cx + Math.cos( a ) * ( r + offset + wob );
				const py = cy + Math.sin( a ) * ( r + offset + wob );
				if ( i === 0 ) ctx.moveTo( px, py ); else ctx.lineTo( px, py );

			}

			ctx.stroke();

		}

	}

	// Long curved drift trails: pairs of near-parallel tracks following a
	// sweeping bezier path.
	const trailCount = 10;
	for ( let t = 0; t < trailCount; t ++ ) {

		const x0 = ( Math.random() - 0.5 ) * worldSize * 0.9;
		const y0 = ( Math.random() - 0.5 ) * worldSize * 0.9;
		const ang = Math.random() * Math.PI * 2;
		const len = worldSize * ( 0.15 + Math.random() * 0.25 );
		const bend = ( Math.random() - 0.5 ) * len * 0.6;

		const x1 = x0 + Math.cos( ang ) * len;
		const y1 = y0 + Math.sin( ang ) * len;
		const mx = ( x0 + x1 ) / 2 - Math.sin( ang ) * bend;
		const my = ( y0 + y1 ) / 2 + Math.cos( ang ) * bend;

		for ( const offset of [ -4, 4 ] ) {

			ctx.lineWidth = 3 + Math.random();
			ctx.globalAlpha = 0.5 + Math.random() * 0.3;
			ctx.beginPath();
			ctx.moveTo( toPx( x0 + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( y0 + Math.sin( ang + Math.PI / 2 ) * offset ) );
			ctx.quadraticCurveTo(
				toPx( mx + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( my + Math.sin( ang + Math.PI / 2 ) * offset ),
				toPx( x1 + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( y1 + Math.sin( ang + Math.PI / 2 ) * offset )
			);
			ctx.stroke();

		}

	}
	ctx.globalAlpha = 1;

	const texture = new THREE.CanvasTexture( canvas );
	return texture;

}

// Racing curb (kerb) edge marking for the open drift arenas — a white
// boundary band running just inside the barrier, with red rumble-strip
// blocks spaced along it, in the same accent red (0xE0621B) already used
// by buildBarrierSegment's own barrier stripe so the two read as one
// consistent "track style" rather than two unrelated colors. Painted
// once across the whole square footprint (same non-repeating-overlay
// technique as createSkidMarksTexture) so the band traces the actual
// perimeter regardless of how large the arena is.
// `worldSize` is the full plane size the texture will be mapped onto;
// `half` is the arena's own half-size (footprint edge distance from
// center) in those same world units.
// worldSizeX/worldSizeZ + halfX/halfZ are now independent (were a single
// worldSize/half assuming a square footprint) so this also maps correctly
// onto a rectangular pad — separate per-axis pixel scales, and the
// perimeter rumble-strip blocks are laid out along each axis using that
// axis's own half-length. Callers with a square footprint just pass the
// same value for both (X/Z), producing byte-identical output to before.
function createTrackEdgeTexture( worldSizeX, worldSizeZ, halfX, halfZ ) {

	const size = 1024;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );

	const pxX = size / worldSizeX; // pixels per world unit, X axis
	const pxZ = size / worldSizeZ; // pixels per world unit, Z axis
	const toPxX = ( w ) => ( w / worldSizeX + 0.5 ) * size;
	const toPxZ = ( w ) => ( w / worldSizeZ + 0.5 ) * size;

	const refHalf = Math.min( halfX, halfZ ); // band thickness stays consistent regardless of aspect ratio
	const bandWidth = Math.max( refHalf * 0.014, 0.4 );  // white band thickness
	const inset = Math.max( refHalf * 0.01, 0.35 );       // gap between the barrier and the band's outer edge
	const blockLen = bandWidth * 2.1;                  // length of each red block along the band
	const gapLen = bandWidth * 1.6;                    // white gap between red blocks

	const outerX = halfX - inset, innerX = outerX - bandWidth;
	const outerZ = halfZ - inset, innerZ = outerZ - bandWidth;
	const bandPxX = bandWidth * pxX;
	const bandPxZ = bandWidth * pxZ;

	// White boundary band, all 4 sides at once (full-canvas-width/height
	// strips so the corners overlap cleanly with no gap).
	ctx.fillStyle = '#f2f2f2';
	ctx.fillRect( 0, toPxZ( -outerZ ), size, bandPxZ );
	ctx.fillRect( 0, toPxZ( innerZ ), size, bandPxZ );
	ctx.fillRect( toPxX( -outerX ), 0, bandPxX, size );
	ctx.fillRect( toPxX( innerX ), 0, bandPxX, size );

	// Red rumble-strip blocks laid on top at regular intervals — one pass
	// along each axis, since the two can now have different lengths.
	ctx.fillStyle = '#E0621B';
	const period = blockLen + gapLen;
	for ( let p = - halfX; p < halfX; p += period ) {

		const len = Math.min( blockLen, halfX - p );
		if ( len <= 0 ) continue;
		const lenPx = len * pxX;
		const startPx = toPxX( p );

		ctx.fillRect( startPx, toPxZ( -outerZ ), lenPx, bandPxZ );
		ctx.fillRect( startPx, toPxZ( innerZ ), lenPx, bandPxZ );

	}
	for ( let p = - halfZ; p < halfZ; p += period ) {

		const len = Math.min( blockLen, halfZ - p );
		if ( len <= 0 ) continue;
		const lenPx = len * pxZ;
		const startPx = toPxZ( p );

		ctx.fillRect( toPxX( -outerX ), startPx, bandPxX, lenPx );
		ctx.fillRect( toPxX( innerX ), startPx, bandPxX, lenPx );

	}

	// Canvas stays transparent outside the drawn bands — meant to be
	// layered over the asphalt, not replace it.
	const texture = new THREE.CanvasTexture( canvas );
	return texture;

}

// Same red/white striped barrier the actual race track uses
// (buildBarrierSegment, runtime-built geometry) placed in a closed loop
// around a square footprint — shared between the web free-roam arena
// and the AR drift pad. Previously used custom-exported GLB assets
// (ground-tile.glb/barrier-segment.glb) instead, but those were
// rendering incorrectly (wrong/washed-out color, barrier segments
// appearing as small disconnected posts instead of continuous barrier
// walls) for reasons not fully root-caused — reverted to this
// proven-working runtime approach rather than keep chasing the asset
// pipeline issue.
// halfZ defaults to halfX, so an existing (square) caller that only ever
// passed one half-length keeps producing exactly the same barrier loop as
// before; a rectangular caller passes both independently.
function buildBarrierLoop( parentGroup, world, halfX, halfZ = halfX, yOffset = 0, heightScale = 1 ) {

	const barrierSeg = 8;

	for ( const sign of [ 1, -1 ] ) {

		for ( let p = - halfX; p < halfX; p += barrierSeg ) {

			const segLen = Math.min( barrierSeg, halfX - p ) - 0.3; // small gaps between segments, like real jersey barrier sections
			if ( segLen <= 0 ) continue;
			const center = p + segLen / 2;

			buildBarrierSegment( parentGroup, world, center, sign * halfZ, segLen, 'x', yOffset, heightScale );

		}

		for ( let p = - halfZ; p < halfZ; p += barrierSeg ) {

			const segLen = Math.min( barrierSeg, halfZ - p ) - 0.3;
			if ( segLen <= 0 ) continue;
			const center = p + segLen / 2;

			buildBarrierSegment( parentGroup, world, sign * halfX, center, segLen, 'z', yOffset, heightScale );

		}

	}

}

// Stadium floodlight pole: a tall mast + lamp head, with a real SpotLight
// aiming down at the track — matching the bright white floodlights over
// a real night "تفحيط" show.
// A bright core + soft additive halo on a lamp's front face, so the
// fixture itself reads as actively lit/glowing rather than a plain dark
// box — same technique as the vehicle's own headlight lens overlay
// (createGlowTexture + an unlit core circle), just added as a child of
// the lamp mesh itself so it automatically inherits the lamp's own
// position/tilt (rotation.x = -0.5) instead of needing that geometry
// recomputed here. Warm creamy-yellow to match the real SpotLight color.
// coreColor/haloColor/haloRgb let a caller push the glow warmer than the
// default cream-yellow (see buildFloodlightPoleVisual's AR-arena call,
// which wants a more orange-leaning fixture) without touching the
// real-scale web version below.
function addFloodlightLensGlow( lamp, coreColor = 0xfff2cc, haloColor = 0xffdba0, haloRgb = '255, 219, 160' ) {

	const core = new THREE.Mesh(
		new THREE.CircleGeometry( 0.13, 16 ),
		new THREE.MeshBasicMaterial( { color: coreColor, toneMapped: false } )
	);
	core.position.z = 0.076; // just proud of the lamp box's front face (half-depth 0.15/2)
	lamp.add( core );

	const halo = new THREE.Mesh(
		new THREE.CircleGeometry( 0.32, 20 ),
		new THREE.MeshBasicMaterial( {
			map: createGlowTexture( haloRgb ), color: haloColor,
			transparent: true, toneMapped: false, depthWrite: false,
			blending: THREE.AdditiveBlending,
		} )
	);
	halo.position.z = 0.074; // just behind the core, avoids z-fighting
	lamp.add( halo );

}

function buildFloodlightPole( scene, x, z, aimTarget, world = null ) {

	const poleHeight = 9;
	const pole = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.12, 0.16, poleHeight, 8 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a3e, roughness: 0.7, metalness: 0.4 } )
	);
	pole.position.set( x, poleHeight / 2, z );
	scene.add( pole );

	// Small lamp head cluster at the top, tilted toward the track.
	const headGroup = new THREE.Group();
	headGroup.position.set( x, poleHeight - 0.1, z );
	headGroup.lookAt( aimTarget.x, 0, aimTarget.z );
	scene.add( headGroup );

	const headMat = new THREE.MeshStandardMaterial( { color: 0x111114, roughness: 0.5, metalness: 0.6 } );
	for ( let i = -1; i <= 1; i ++ ) {

		const lamp = new THREE.Mesh( new THREE.BoxGeometry( 0.5, 0.35, 0.15 ), headMat );
		lamp.position.set( i * 0.6, 0, 0.3 );
		lamp.rotation.x = -0.5;
		headGroup.add( lamp );
		addFloodlightLensGlow( lamp );

	}

	// Warm creamy-yellow, like a real stadium floodlight (not cool white) —
	// same base intensity/distance/cone as before, only the color changed.
	const light = new THREE.SpotLight( 0xffdba0, 45, 70, THREE.MathUtils.degToRad( 42 ), 0.4, 1.0 );
	light.position.set( x, poleHeight - 0.1, z );
	light.target.position.set( aimTarget.x, 0, aimTarget.z );
	scene.add( light );
	scene.add( light.target );

	// Solid collider so the car actually crashes into the pole instead of
	// driving straight through it — a Y-axis cylinder (crashcat has a real
	// cylinder shape, registered via registerAll()) matching the pole
	// mesh's own radius/height, so it's a snug fit rather than a boxy
	// approximation.
	if ( world ) {

		rigidBody.create( world, {
			shape: cylinder.create( { halfHeight: poleHeight / 2, radius: 0.16 } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ x, poleHeight / 2, z ],
			friction: 0.4,
			restitution: 0.15,
		} );

	}

}

// ─── Drift arena dressing: barriers, tire stacks, gate, signs ─

// Concrete jersey barrier segment: gray base + a painted orange/white
// hazard stripe near the top, the standard look for track-edge barriers.
function buildBarrierSegment( scene, world, x, z, length, axis, yOffset = 0, heightScale = 1 ) {

	const h = 0.6 * heightScale, w = 0.35;
	const sizeX = axis === 'x' ? length : w;
	const sizeZ = axis === 'x' ? w : length;

	const body = new THREE.Mesh(
		new THREE.BoxGeometry( sizeX, h, sizeZ ),
		new THREE.MeshStandardMaterial( { color: 0x9a9a92, roughness: 0.95, metalness: 0 } )
	);
	body.position.set( x, h / 2 + yOffset, z );
	scene.add( body );

	const stripe = new THREE.Mesh(
		new THREE.BoxGeometry( axis === 'x' ? sizeX : sizeX * 1.02, 0.12 * heightScale, axis === 'x' ? sizeZ * 1.02 : sizeZ ),
		new THREE.MeshStandardMaterial( { color: 0xE0621B, roughness: 0.8 } )
	);
	stripe.position.set( x, h * 0.72 + yOffset, z );
	scene.add( stripe );

	if ( world ) {

		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ sizeX / 2, h / 2, sizeZ / 2 ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ x, h / 2 - 0.125 + yOffset, z ],
			friction: 0.3,
			restitution: 0.25,
		} );

	}

}

// A stack of tires (torus "tires", genuinely stacked) — decorative corner
// dressing, common at any real drift arena's edge.
function buildTireStack( scene, x, z, count ) {

	const tireMat = new THREE.MeshStandardMaterial( { color: 0x1c1c1e, roughness: 0.9, metalness: 0 } );
	let y = 0.12;

	for ( let i = 0; i < count; i ++ ) {

		const tire = new THREE.Mesh( new THREE.TorusGeometry( 0.35, 0.13, 10, 20 ), tireMat );
		tire.rotation.x = Math.PI / 2;
		tire.position.set( x + ( Math.random() - 0.5 ) * 0.04, y, z + ( Math.random() - 0.5 ) * 0.04 );
		scene.add( tire );
		y += 0.23;

	}

}

// Entrance gate: two pillars + a header beam, straddling one edge of the
// arena — purely a visual landmark (the barrier line behind it is still
// the actual boundary).
function buildEntranceGate( scene, x, z, axis ) {

	const pillarH = 4.2, pillarSize = 0.35, gap = 3.6;
	const mat = new THREE.MeshStandardMaterial( { color: 0x2c2c30, roughness: 0.6, metalness: 0.5 } );

	for ( const side of [ -1, 1 ] ) {

		const px = axis === 'x' ? x + side * gap / 2 : x;
		const pz = axis === 'x' ? z : z + side * gap / 2;
		const pillar = new THREE.Mesh( new THREE.BoxGeometry( pillarSize, pillarH, pillarSize ), mat );
		pillar.position.set( px, pillarH / 2, pz );
		scene.add( pillar );

	}

	const beam = new THREE.Mesh(
		new THREE.BoxGeometry( axis === 'x' ? gap + pillarSize : pillarSize, 0.4, axis === 'x' ? pillarSize : gap + pillarSize ),
		mat
	);
	beam.position.set( x, pillarH + 0.2, z );
	scene.add( beam );

}

// Warning sign: yellow triangle on a post — no text/glyphs, just the
// hazard-triangle shape.
function buildWarningSign( scene, x, z, rotationY ) {

	const post = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.03, 0.03, 1.1, 6 ),
		new THREE.MeshStandardMaterial( { color: 0x333333, roughness: 0.7 } )
	);
	post.position.set( x, 0.55, z );
	scene.add( post );

	const shape = new THREE.Shape();
	shape.moveTo( 0, 0.32 );
	shape.lineTo( -0.28, -0.18 );
	shape.lineTo( 0.28, -0.18 );
	shape.closePath();

	const face = new THREE.Mesh(
		new THREE.ShapeGeometry( shape ),
		new THREE.MeshStandardMaterial( { color: 0xF2C230, roughness: 0.6, side: THREE.DoubleSide } )
	);
	const border = new THREE.Mesh(
		new THREE.RingGeometry( 0.26, 0.30, 3 ),
		new THREE.MeshStandardMaterial( { color: 0x1a1a1a, roughness: 0.6, side: THREE.DoubleSide } )
	);
	border.rotation.z = Math.PI; // point the ring-triangle the same way as the face

	const signGroup = new THREE.Group();
	signGroup.add( face );
	signGroup.add( border );
	signGroup.position.set( x, 1.15, z );
	signGroup.rotation.y = rotationY;
	scene.add( signGroup );

}

// Floodlight pole for contexts like the AR floating arena where the whole
// group gets scaled down to tabletop size — takes a `scale` (the same
// FIXED_SCALE knob used everywhere else) and scales the SpotLight's
// distance/intensity down by it too, exactly like updateVehicleLights()
// scales headlight/taillight/hazard base values. A real-world-scale light
// (base 45/70, matching buildFloodlightPole) would blow out the tiny
// scaled-down scene, hence the scaling instead of just omitting the light.
function buildFloodlightPoleVisual( parent, x, z, aimTarget, poleHeight = 9, scale = 1 ) {

	const pole = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.12, 0.16, poleHeight, 8 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a3e, roughness: 0.7, metalness: 0.4 } )
	);
	pole.position.set( x, poleHeight / 2, z );
	parent.add( pole );

	const headGroup = new THREE.Group();
	headGroup.position.set( x, poleHeight - 0.1, z );
	headGroup.lookAt( aimTarget.x, 0, aimTarget.z );
	parent.add( headGroup );

	const headMat = new THREE.MeshStandardMaterial( { color: 0x111114, roughness: 0.5, metalness: 0.6 } );
	for ( let i = -1; i <= 1; i ++ ) {

		const lamp = new THREE.Mesh( new THREE.BoxGeometry( 0.5, 0.35, 0.15 ), headMat );
		lamp.position.set( i * 0.6, 0, 0.3 );
		lamp.rotation.x = -0.5;
		headGroup.add( lamp );
		// Pushed warmer/more orange than the real-scale web version
		// (0xfff2cc/0xffdba0) per feedback — these fixtures are pure
		// decoration in AR (see below), so the glow itself carries all
		// of their "lit" read.
		addFloodlightLensGlow( lamp, 0xffd9a3, 0xffb066, '255, 176, 102' );

	}

	// No real SpotLight here (removed per feedback): on the AR tabletop
	// these fixtures should read as decoration only, not actually light
	// the scene — the lens glow above already sells "lit up" without a
	// dynamic light source. `scale` is kept as a param for call-site
	// compatibility even though it's now unused.
	void scale;

}

// Tire stacks + a parked decoration car scattered near each of the
// arena's 4 corners — random tire count and a little position jitter
// each time so the four corners don't look copy-pasted, and a randomly
// picked truck model parked nearby (skipped occasionally so it's not
// mechanically "always all 4 corners"). Shared between the web
// free-roam arena and the AR floating arena/drift pad; `parent` is
// whatever group/scene those add their own dressing to, so this works
// unscaled (world space) or inside a group that later gets uniformly
// scaled down for AR.
// halfZ defaults to halfX (square, backward-compatible); a rectangular
// caller passes both independently so each corner cluster sits inset
// proportionally on both axes instead of assuming a square footprint.
// Always returns the list of what it actually placed (position/rotation/
// tire count) so a caller can build matching physics colliders — either
// right away by passing `world` (web free-roam, where the physics world
// already exists at call time), or later from the returned list once it
// does exist (the AR arena, whose physics world isn't created until
// lock-in, well after this runs at preview time — see buildDriftPad).
function scatterCornerDecor( parent, models, halfX, halfZ = halfX, truckKeys, world = null ) {

	const marginX = halfX * 0.14; // how far inside the corner the cluster sits
	const marginZ = halfZ * 0.14;
	const jitterX = halfX * 0.05;
	const jitterZ = halfZ * 0.05;

	const decor = [];

	for ( const sx of [ -1, 1 ] ) {

		for ( const sz of [ -1, 1 ] ) {

			const cx = sx * ( halfX - marginX );
			const cz = sz * ( halfZ - marginZ );

			const tireCount = 3 + Math.floor( Math.random() * 4 ); // 3-6
			const tireX = cx + ( Math.random() - 0.5 ) * jitterX * 2;
			const tireZ = cz + ( Math.random() - 0.5 ) * jitterZ * 2;
			buildTireStack( parent, tireX, tireZ, tireCount );
			decor.push( { type: 'tires', x: tireX, z: tireZ, count: tireCount } );

			if ( truckKeys.length > 0 && Math.random() < 0.85 ) {

				const key = truckKeys[ Math.floor( Math.random() * truckKeys.length ) ];
				const src = models[ key ];

				if ( src ) {

					const car = src.clone();
					// Offset toward the arena's center relative to the tire
					// stack, away from the corner point, so the two don't
					// overlap each other.
					const carX = cx - sx * jitterX * 1.8 + ( Math.random() - 0.5 ) * jitterX;
					const carZ = cz - sz * jitterZ * 1.8 + ( Math.random() - 0.5 ) * jitterZ;
					car.position.set( carX, 0, carZ );
					car.rotation.y = Math.random() * Math.PI * 2;
					parent.add( car );
					decor.push( { type: 'car', x: carX, z: carZ, rotationY: car.rotation.y } );

				}

			}

		}

	}

	if ( world ) addDecorColliders( world, decor );

	return decor;

}

// Static colliders matching scatterCornerDecor()'s placed tire stacks/
// decoration cars, so the car actually crashes into them instead of
// driving straight through — same idea as buildFloodlightPole's new
// collider. The tire stack (a bundle of tori) is approximated as a
// cylinder of the same footprint/height; crashcat has no compound-mesh
// shape that would match the real stacked-tire silhouette. The
// decoration car is a rotated box (crashcat's `quaternion` body setting)
// sized like a real pickup truck, matching its randomized rotation.y so
// the collider actually lines up with however the model was placed.
function addDecorColliders( world, decorList, yOffset = 0 ) {

	const _q = new THREE.Quaternion();
	const _up = new THREE.Vector3( 0, 1, 0 );

	for ( const d of decorList ) {

		if ( d.type === 'tires' ) {

			const stackHeight = 0.12 + d.count * 0.23; // matches buildTireStack's own y progression
			rigidBody.create( world, {
				shape: cylinder.create( { halfHeight: stackHeight / 2, radius: 0.42 } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ d.x, stackHeight / 2 + yOffset, d.z ],
				friction: 0.5,
				restitution: 0.2,
			} );

		} else if ( d.type === 'car' ) {

			_q.setFromAxisAngle( _up, d.rotationY );
			const halfW = 0.95, halfH = 0.65, halfL = 1.95; // rough real-world pickup-truck footprint
			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ halfW, halfH, halfL ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ d.x, halfH + yOffset, d.z ],
				quaternion: [ _q.x, _q.y, _q.z, _q.w ],
				friction: 0.4,
				restitution: 0.25,
			} );

		}

	}

}

// ─── Custom windshield/tailgate text decal ─────────────────

function createTextTexture( text ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 512;
	canvas.height = 256;
	const ctx = canvas.getContext( '2d' );
	ctx.clearRect( 0, 0, 512, 256 );

	// Basic Arabic-range check so RTL text is drawn with correct direction;
	// canvas glyph shaping/joining works either way, this mainly affects
	// alignment when the string mixes scripts.
	if ( /[\u0600-\u06FF]/.test( text ) ) ctx.direction = 'rtl';

	ctx.font = 'bold 110px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.lineWidth = 10;
	ctx.strokeStyle = '#000000';
	ctx.strokeText( text, 256, 128 );
	ctx.fillStyle = '#ffffff';
	ctx.fillText( text, 256, 128 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;

}

// ─── Per-vehicle-shape add-on layout (static, hand-calibrated) ──
// Headlights/taillights/hazards/the rear flag/the name decals each sit at
// a fixed (x, y, z) local position, one full table per vehicle body shape
// (all in "pre-scale" units — every add-on is parented as a child of
// vehicleModel, so vehicleModel's own scale, e.g. 0.33 for the Camry,
// already applies to these numbers once automatically at render time).
// x is the RIGHT-side magnitude — the headlight/taillight/hazard/spotlight
// pairs mirror it to ±x for the left/right side.
//
// This used to be computed at runtime from each model's own live bounding
// box (vehicleBounds()/addonPos()), to generalize the truck's original
// hand-measured numbers to the Camry/Camaro's very different proportions
// without hand-tuning each one. That runtime system went through two
// rounds of subtle bugs (world-space-contaminated bounds on rotated/
// moving cars, then a double-scaling bug that put every add-on at half
// its intended distance) before it was fully correct. Per feedback,
// reverted to plain static numbers per vehicle shape: the truck table
// below reproduces the truck's exact prior on-screen placement (frozen
// from the now-verified runtime formula), and the Camry/Camaro tables are
// separately calibrated against those models' own measured proportions.
// Simpler, and nothing left to break at runtime.
// ✏️ RETUNING KNOB — headlightLens/taillight/hazards' y and flag's y each
// nudged up +0.45 total net (0.03, 0.03, 0.06, 0.12, 0.36, then back down
// 0.15 — six passes) per feedback that the front lighting, hazards, and
// flag were all sitting a bit low, then a touch too high. headlightSpot's
// y raised/lowered by the same amount to keep the actual light source
// aligned with the visible lens; headlightSpotTarget (far-ahead aim point)
// and reverseLight are unaffected — same reasoning as the z-only
// headlightSpot nudge below.
// headlightLens' own z was pulled forward +0.1, then per feedback that it
// no longer sat flush against the model's own headlight-lens bump, pulled
// back -0.05, then -0.03 more (net +0.02 from the original). Its y was
// also lowered -0.03 in this same pass. The front hazard PAIR's z/y are
// deliberately left at their prior values below (per explicit feedback:
// hazards/flag are fine, don't touch them) — hazards and headlightLens no
// longer share identical y/z as a result, unlike every other coordinate.
// headlightSpot's y is kept in sync with headlightLens' own y (same
// reasoning as the original total-lift passes above); its z is untouched.
// ✏️ windshieldDecal/tailgateDecal (the custom name text) and reverseLight
// y raised to match headlightLens' own y, then lowered -0.03, then -0.03
// again per follow-up feedback — same for all 3 vehicles below, each
// matched to its own headlightLens.y.
const TRUCK_LAYOUT = {
	headlightLens: [ 0.3975, 0.719, 1.42 ],
	taillight: [ 0.3975, 0.879, -1.33 ],
	reverseLight: [ 0.24975, 0.659, -1.3398 ],
	flag: [ -0.6, 0.593, -1.358 ],
	windshieldDecal: [ 0, 0.659, 0.574 ],
	tailgateDecal: [ 0, 0.659, -1.4 ],
	// headlightSpot's z (how far past headlightLens the actual light
	// SOURCE floats, in open air above the roof — see addVehicleLights())
	// pulled in per feedback that the lighting read as sitting too far
	// forward of the car. Only z moves; y (height above the roof — what
	// actually keeps the beam from clipping/overexposing the car's own
	// hood) and headlightSpotTarget (aim point far ahead, unaffected by
	// this small a shift in the source) are untouched.
	// x corrected to match headlightLens.x (0.3975) — it had been
	// carrying flag.x's magnitude (0.6, from the opposite rear corner of
	// the car, unrelated to the headlights) instead, so the actual light
	// source sat noticeably outboard of the visible lens it's supposed to
	// shine from. headlightSpotTarget.x moved the same amount so the beam
	// still aims straight ahead rather than on an inward slant.
	headlightSpot: [ 0.3975, 2.5195, 1.7612 ],
	headlightSpotTarget: [ 0.3975, 0.2002, 18.004 ],
	hazards: [
		[ -0.3975, 0.749, 1.5 ], [ 0.3975, 0.749, 1.5 ],
		[ -0.3975, 0.879, -1.33 ], [ 0.3975, 0.879, -1.33 ],
	],
};

// headlightLens/taillight/hazards below were re-measured directly off
// each model's own headlight/taillight graphics (sampling the Camry's
// baked paint texture for its teal headlight-lens/red taillight-lens
// pixels, and Camaro's dedicated "Lights"/"Red" materials — see
// precise_calibrate_camry.html/precise_calibrate_camaro.html), after the
// original fractions-borrowed-from-the-truck placement put them
// noticeably low and too far inboard on both cars (most visible on the
// Camry, reported as the headlights/taillights "not sitting right").
// reverseLight keeps the same x/y/z ratio to taillight the truck's own
// numbers already use (×0.628 / ×1 / ×1.0074) — there's no dedicated
// reverse-light graphic on either model to sample directly.
// ✏️ Same +0.45 total net lift and headlightLens y/z adjustment as
// TRUCK_LAYOUT above — see its comment for why.
// ✏️ Checked/adjusted per explicit request: hazards (all 4 corners) +
// taillight lowered -0.24 so there's a deliberate gap with headlights
// sitting above and hazards below — same "headlights up, hazards down"
// separation confirmed working for Camaro, this vehicle just hadn't
// gotten it yet (it was still sharing Truck's numbers up to this point).
// Flag left as-is — nothing specific was flagged wrong with it.
const CAMRY_LAYOUT = {
	headlightLens: [ 0.6535, 0.9398, 2.234 ],
	taillight: [ 0.7639, 0.9848, -2.3324 ],
	reverseLight: [ 0.4797, 0.8798, -2.3496 ],
	flag: [ -0.8744, 0.4842, -2.5813 ],
	// windshieldDecal/tailgateDecal/reverseLight y raised to match
	// headlightLens' own y, then lowered -0.03, then -0.03 again — see the
	// identical change in TRUCK_LAYOUT above for why.
	windshieldDecal: [ 0, 0.8798, 1.0567 ],
	tailgateDecal: [ 0, 0.8798, -2.6611 ],
	// headlightSpot's z pulled in — same reasoning as TRUCK_LAYOUT above.
	// The Camry's old z carried a disproportionately large forward offset
	// (≈66% of its own lens-z, vs ≈43-49% for the truck/Camaro) — a relic
	// of the same naive truck-fraction scaling that originally put its
	// headlightLens in the wrong spot too — so it's pulled in further
	// (to ≈45% of the old offset, vs 60% for the other two) to land at a
	// comparable proportion.
	// x corrected to headlightLens.x (0.6535) — see the identical fix in
	// TRUCK_LAYOUT above for why (it had been flag.x's 0.8744 instead).
	headlightSpot: [ 0.6535, 2.8218, 2.8763 ],
	headlightSpotTarget: [ 0.6535, 0.1034, 33.1454 ],
	hazards: [
		[ -0.6535, 0.7298, 2.314 ], [ 0.6535, 0.7298, 2.314 ],
		[ -0.7639, 0.9848, -2.3324 ], [ 0.7639, 0.9848, -2.3324 ],
	],
};

// ✏️ Same +0.45 total net lift and headlightLens y/z adjustment as
// TRUCK_LAYOUT above — see its comment for why. Camaro-ONLY from here —
// Truck/Camry are completely unaffected, this table is fully independent
// of theirs:
// - headlightLens/headlightSpot y lowered another -0.24 (double the prior
//   -0.12 step).
// - hazards (all 4 corners) lowered -0.48 (double THAT amount) so there's
//   a clear, deliberate gap with headlights sitting above and hazards
//   below, per explicit request — previously they sat almost level.
//   taillight lowered the same -0.48 alongside the rear hazard pair to
//   keep the two co-located, same reasoning as everywhere else in this
//   file.
// - flag pulled forward (z toward the car, +0.1) and lowered (-0.05); per
//   follow-up feedback the flag is now right, so it's untouched below.
// - headlightLens' LEFT side only (side===-1 in addVehicleLights, i.e.
//   headlightLensLeftXOffset below) nudged further left/outward; the
//   right side is untouched — see addVehicleLights()'s own comment on why
//   this needed a new asymmetric-offset mechanism instead of the usual
//   mirrored `sidePos()`. Nudged again -0.03 in the same follow-up pass
//   that lowered headlightLens/headlightSpot/hazards a bit further, then
//   -0.03 more in a later pass on its own.
const CAMARO_LAYOUT = {
	headlightLens: [ 0.3584, 0.366, 1.3512 ],
	// Left headlightLens only — see addVehicleLights()'s own comment.
	headlightLensLeftXOffset: -0.11,
	taillight: [ 0.3123, 0.2076, -1.5104 ],
	reverseLight: [ 0.1961, 0.306, -1.5215 ],
	flag: [ -0.4603, 0.4862, -1.3774 ],
	// windshieldDecal/tailgateDecal/reverseLight y raised to match
	// headlightLens' own y, then lowered -0.03, then -0.03 again — see the
	// identical change in TRUCK_LAYOUT above for why.
	windshieldDecal: [ 0, 0.306, 0.569 ],
	tailgateDecal: [ 0, 0.306, -1.5231 ],
	// headlightSpot's z pulled in — same reasoning as TRUCK_LAYOUT above.
	// x corrected to headlightLens.x (0.3584) — see the identical fix in
	// TRUCK_LAYOUT above for why (it had been flag.x's 0.4603 instead).
	headlightSpot: [ 0.3584, 1.1819, 1.7232 ],
	headlightSpotTarget: [ 0.3584, 0.1209, 17.8476 ],
	hazards: [
		[ -0.3584, 0.156, 1.4312 ], [ 0.3584, 0.156, 1.4312 ],
		[ -0.3123, 0.2076, -1.5104 ], [ 0.3123, 0.2076, -1.5104 ],
	],
};

const VEHICLE_ADDON_LAYOUTS = {
	'vehicle-camry': CAMRY_LAYOUT,
	'vehicle-camaro': CAMARO_LAYOUT,
};

// Falls back to the truck layout for every truck-based vehicle key (and
// as a safe default for anything untagged).
function layoutFor( vehicleModel ) {

	const key = vehicleModel.userData && vehicleModel.userData.vehicleKey;
	return VEHICLE_ADDON_LAYOUTS[ key ] || TRUCK_LAYOUT;

}

function sidePos( xyz, side ) {

	return new THREE.Vector3( xyz[ 0 ] * side, xyz[ 1 ], xyz[ 2 ] );

}

// Adds the user's custom text on the windshield (facing forward) and the
// tailgate (facing backward), as children of the model's TOP-LEVEL group
// (not the "body" mesh node itself — see the note on anchorNode in
// addVehicleLights() just below for why) so they inherit its position/
// suspension-lean animation automatically. Positions come from the static
// per-vehicle-shape layout tables above — purely cosmetic decals, no
// change to Vehicle.js or the model's own geometry.
function addCustomTextDecals( vehicleGroup, text ) {

	if ( ! text ) return;

	const vehicleModel = vehicleGroup.children[ 0 ];
	const anchorNode = vehicleModel;
	const layout = layoutFor( vehicleModel );

	const texture = createTextTexture( text );
	const material = new THREE.MeshBasicMaterial( {
		// Single-sided on purpose: with DoubleSide, the front decal's
		// back face was visible (mirrored) from behind the vehicle over
		// the roofline, and vice versa for the rear decal. FrontSide
		// means each sticker only shows from its own correct side, like
		// a real decal.
		map: texture, transparent: true, depthWrite: false, side: THREE.FrontSide,
	} );

	// Windshield glass, sized to sit inside the glass panel itself (not
	// the whole frame) and offset just enough past the glass surface to
	// avoid z-fighting, like a sticker applied to the glass.
	const windshieldDecal = new THREE.Mesh( new THREE.PlaneGeometry( 0.62, 0.34 ), material );
	windshieldDecal.position.set( ...layout.windshieldDecal );
	windshieldDecal.renderOrder = 10;
	anchorNode.add( windshieldDecal );

	// Rear window/panel.
	const tailgateDecal = new THREE.Mesh( new THREE.PlaneGeometry( 1.0, 0.5 ), material );
	tailgateDecal.position.set( ...layout.tailgateDecal );
	tailgateDecal.rotation.y = Math.PI; // face backward
	tailgateDecal.renderOrder = 10;
	anchorNode.add( tailgateDecal );

}

// ─── Rear flag: pole-mounted, driver's-side corner ───────────
// Saudi Arabia drives left-hand-drive (driver's seat on the left), so
// "driver's side" = the vehicle's left = negative local x, matching the
// side=-1 convention already used for the taillights/reverse lights
// below. Mounted low, at rear-bumper/spare-tire height (not roof height)
// and near the left edge — matching a real full-size flag planted at the
// back of the vehicle, leaning up and outward, rather than a small
// roof-mounted pennant.
function addVehicleFlag( vehicle, imageUrl ) {

	const vehicleGroup = vehicle.container;
	const vehicleModel = vehicleGroup.children[ 0 ];
	const layout = layoutFor( vehicleModel );

	// Anchored to the body pivot, same as addVehicleLights() — see its own
	// comment on anchorNode/_bodyInvMatrix for why this has to go through
	// a proper world-space matrix conversion, not a plain position
	// subtraction (which put the flag entirely inside the Camry's body —
	// same root cause as the headlights).
	const anchorNode = vehicle.bodyNode || vehicleModel;
	const _bodyInvMatrix = new THREE.Matrix4();
	if ( vehicle.bodyNode ) {

		vehicleModel.updateMatrixWorld( true );
		vehicle.bodyNode.updateMatrixWorld( true );
		_bodyInvMatrix.copy( vehicle.bodyNode.matrixWorld ).invert();

	}

	const flag = createFlag( imageUrl );
	// Pole planted right at the rear bumper — pulled left (clear of the
	// bumper's width) and just past its depth, not floating away from it.
	const flagPosition = new THREE.Vector3( ...layout.flag );
	if ( vehicle.bodyNode ) flagPosition.applyMatrix4( vehicleModel.matrixWorld ).applyMatrix4( _bodyInvMatrix );
	flag.group.position.copy( flagPosition );
	anchorNode.add( flag.group );

	return flag;

}

// ─── Real headlight / taillight lighting ───────────────────
// Positions come from the static per-vehicle-shape layout tables above —
// one calibrated set per vehicle body (truck / Camry / Camaro).
// `realHazards`: true only for the PLAYER's own car (see the 4 call
// sites that pass it) — gives that one car's hazard lights a real
// THREE.PointLight per corner (same settings as the taillights just
// below: baseDistance 0.9 / baseIntensity 0.8 / decay 2 — reused
// as-is per feedback that they already look right), so they actually
// look lit, not just a flat glow mesh. AI cars keep the cheap unlit
// lens-glow version (the default, `realHazards` omitted) — with
// several AI cars blinking hazards at once, real lights per corner
// per car was the likely cause of the earlier reported hang, and
// there's no gameplay reason for an AI car's hazards to illuminate
// anything. One player car adding 4 real lights back is negligible
// by comparison.
function addVehicleLights( vehicle, realHazards = false ) {

	const vehicleGroup = vehicle.container;
	const vehicleModel = vehicleGroup.children[ 0 ];
	const layout = layoutFor( vehicleModel );

	// Headlights/hazards/taillights/reverse lights anchor to the body
	// pivot (vehicle.bodyNode — see Vehicle.js's createPivot()/
	// updateBody()) instead of vehicleModel directly, so they visually
	// follow the body's own launch-pitch/lean/suspension-settle animation
	// instead of staying rigidly fixed while the body tilts underneath
	// them (reported: the front visibly rises under hard acceleration but
	// the lighting stayed put, reading as detached from the car). Falls
	// back to vehicleModel itself for any model with no recognizable
	// "body" node (bodyNode stays null — see Vehicle.js's init()).
	//
	// bodyNode is a child of bodyChild's own immediate parent, which is
	// NOT necessarily vehicleModel itself — createPivot(bodyChild) inserts
	// the pivot exactly where bodyChild already lived, and vehicleModel's
	// traverse() in Vehicle.js's init() finds "body" wherever it sits in
	// the whole descendant tree, however many levels deep. For Camry
	// specifically that's several levels down through nodes carrying their
	// own extra scale (a ~100x centimeters-vs-meters artifact — see
	// Vehicle.js's own _bodySuspensionSinkLocal comment for the full
	// story), so bodyNode's local units are NOT the same size as
	// vehicleModel's own local units there. A first version of this
	// compensated only by subtracting bodyNode.position (a pure
	// translation) — correct for Truck/Camaro (no such extra scale, so a
	// no-op difference from doing it "right"), but on Camry it put every
	// light/decal/flag position wildly off (reported: entirely inside the
	// car body, invisible) because a translation-only fix can't correct
	// for a scale mismatch between the two frames. anchoredPos() below
	// instead converts properly through world space (vehicleModel's own
	// matrixWorld out, bodyNode's inverse matrixWorld in), which is
	// correct regardless of any scale/rotation/nesting differences between
	// the two frames — not just a Camry-specific patch.
	const anchorNode = vehicle.bodyNode || vehicleModel;
	const _bodyInvMatrix = new THREE.Matrix4();
	if ( vehicle.bodyNode ) {

		vehicleModel.updateMatrixWorld( true );
		vehicle.bodyNode.updateMatrixWorld( true );
		_bodyInvMatrix.copy( vehicle.bodyNode.matrixWorld ).invert();

	}

	function anchoredPos( v ) {

		if ( vehicle.bodyNode ) v.applyMatrix4( vehicleModel.matrixWorld ).applyMatrix4( _bodyInvMatrix );
		return v;

	}

	// Optional per-vehicle asymmetric nudge, LEFT side (side===-1) only —
	// e.g. CAMARO_LAYOUT's headlightLensLeftXOffset. Every other coordinate
	// in these layout tables mirrors symmetrically via sidePos()'s own side
	// multiplier; this is the one deliberate exception, added to nudge just
	// the driver's-side headlight further outward without moving its
	// mirror on the right. Applied to both the visible lens and the actual
	// illuminating spot, so they stay aligned with each other like every
	// other headlight coordinate in this file.
	function applyLeftOffset( v, side ) {

		if ( side === -1 && layout.headlightLensLeftXOffset ) v.x += layout.headlightLensLeftXOffset;
		return v;

	}

	// Headlights: warm-white point lights, lighting up the real room
	// ahead in AR. Off by default — toggled by the player.
	// Mounted well above and ahead of the car (like a roof light bar)
	// instead of right at the bumper — being that close to the car's own
	// paint was overexposing/whiting-out the car itself (inverse-square
	// falloff means intensity right next to the source is extreme) while
	// barely reaching the room a couple meters out.
	// Headlights: warm-white spotlights, lighting up the real room ahead
	// in AR. Off by default — toggled by the player.
	// A PointLight mounted on the car always over-lit the car itself no
	// matter how far out it was pushed, since the car's own body is
	// rigidly attached nearby while the room is much farther — the car
	// dominates the illumination by inverse-square law regardless of
	// placement. Switched to a narrow directional SpotLight mounted
	// clear above the roof (not touching any geometry, unlike the first
	// SpotLight attempt) and aimed forward with a gentle downward tilt
	// calculated to clear the hood/roof entirely, so the beam only ever
	// hits the room, never the car's own body.
	// ✏️ THIS is where headlight brightness actually comes from —
	// baseIntensity below, not the intensityScale multiplier in
	// updateVehicleLights()/setHighBeam() further down this file (that
	// multiplier only scales this base number down for AR's tiny
	// FIXED_SCALE; in NORMAL/web mode scale=1 so the light renders at
	// exactly this baseIntensity, unscaled). Cut hard (3000 → 500, ~83%)
	// per feedback that it was still far too strong after the earlier
	// scaling-curve fix — that fix only affected AR's relative dimming,
	// it never touched this base number, so web mode never actually got
	// dimmer from it. Lower this single number to dim headlights further
	// (setHighBeam()'s high-beam boost is a flat ×2.5 on top of whatever
	// this is, so it scales down together with it automatically).
	const headlights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 14;
		const baseIntensity = 500;
		const light = new THREE.SpotLight( 0xfff2cc, baseIntensity, baseDistance, Math.PI / 8, 0.35, 2 );
		const basePosition = anchoredPos( applyLeftOffset( sidePos( layout.headlightSpot, side ), side ) ); // clear above the roof, open air
		light.position.copy( basePosition );
		light.visible = false;

		// The aim target stays under vehicleModel (NOT anchorNode/bodyNode)
		// on purpose — it's a point far ahead (z in the tens of units), so
		// even the small rotation bodyNode's own launch-pitch animation
		// applies would swing it sideways by a wildly amplified arc length
		// at that distance. Only the light SOURCE needs to move with the
		// body; letting just that shift the beam's angle relative to a
		// fixed-ahead aim point is enough to read as "mounted on the car".
		const target = new THREE.Object3D();
		const baseTargetPosition = sidePos( layout.headlightSpotTarget, side ); // far ahead, gentle downward slope
		target.position.copy( baseTargetPosition );
		vehicleModel.add( target );
		light.target = target;

		anchorNode.add( light );
		headlights.push( { light, target, basePosition, baseTargetPosition, baseDistance, baseIntensity } );

	}

	// Glowing "lens" overlays at the actual headlight bumps on the body —
	// separate from the actual illuminating light above, which is
	// roof-mounted so its beam clears the car. This is purely visual:
	// makes the headlight bump itself look lit (bright white with a soft
	// glow) when toggled on, since the shared body material can't be
	// selectively recolored without touching the model file.
	const headlightLenses = [];
	for ( const side of [ -1, 1 ] ) {

		const group = new THREE.Group();
		const basePosition = anchoredPos( applyLeftOffset( sidePos( layout.headlightLens, side ), side ) );
		group.position.copy( basePosition );
		group.userData.basePosition = basePosition;
		group.visible = false;

		const core = new THREE.Mesh(
			new THREE.CircleGeometry( 0.075, 16 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, toneMapped: false } )
		);
		group.add( core );

		const halo = new THREE.Mesh(
			new THREE.CircleGeometry( 0.16, 24 ),
			new THREE.MeshBasicMaterial( {
				map: createGlowTexture( '255, 242, 204' ), color: 0xfff2cc,
				transparent: true, toneMapped: false, depthWrite: false,
				blending: THREE.AdditiveBlending,
			} )
		);
		halo.position.z = -0.002; // just behind the core, avoids z-fighting
		group.add( halo );

		anchorNode.add( group );
		headlightLenses.push( group );

	}

	// Taillights: small, short-range red glow, always on — real
	// taillights don't meaningfully illuminate anything, this is just a
	// soft tint near the rear. (Kept at the same intensity that already
	// looked right — short range makes it visible even at low candela.)
	const taillights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 0.9;
		const baseIntensity = 0.8;
		const light = new THREE.PointLight( 0xff3b30, baseIntensity, baseDistance, 2 );
		const basePosition = anchoredPos( sidePos( layout.taillight, side ) );
		light.position.copy( basePosition );
		anchorNode.add( light );
		taillights.push( { light, basePosition, baseDistance, baseIntensity } );

	}

	// Reverse (backup) lights: white glow at the rear, next to the
	// taillights, only lit while the car is actually reversing (driven
	// from linearSpeed < 0 in updateVehicleLights — no manual toggle,
	// same as a real car). Pure unlit lens glow (core + additive halo,
	// same technique as the headlight lens / floodlight pole lamps) —
	// NOT a real THREE.PointLight anymore. A real backup light doesn't
	// meaningfully illuminate anything at this range either (same as the
	// taillights' own comment above), so the only thing lost by dropping
	// the real light is a faint, largely pointless ground spill — while
	// what's gained is one fewer real dynamic light per vehicle, per
	// side, that the renderer has to evaluate for every pixel of every
	// surface in the scene every frame. With several vehicles reversing
	// at once (or hazards below, same idea) those real point lights were
	// a likely cause of the reported "reversing/hazards sometimes causes
	// a hang" — three.js's default forward lighting pays a real, fixed
	// per-pixel shader cost for every additional active light, unrelated
	// to how dim or short-range it is.
	const reverseLights = [];
	for ( const side of [ -1, 1 ] ) {

		const basePosition = anchoredPos( sidePos( layout.reverseLight, side ) );
		const group = new THREE.Group();
		group.position.copy( basePosition );
		group.rotation.y = Math.PI; // face backward, out through the taillight bump
		group.visible = false;
		anchorNode.add( group );

		const core = new THREE.Mesh(
			new THREE.CircleGeometry( 0.035, 16 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, toneMapped: false } )
		);
		group.add( core );

		const halo = new THREE.Mesh(
			new THREE.CircleGeometry( 0.09, 16 ),
			new THREE.MeshBasicMaterial( {
				map: createGlowTexture( '245, 249, 255' ), color: 0xf5f9ff,
				transparent: true, toneMapped: false, depthWrite: false,
				blending: THREE.AdditiveBlending,
			} )
		);
		halo.position.z = -0.002; // just behind the core, avoids z-fighting
		group.add( halo );

		reverseLights.push( { group, basePosition } );

	}

	// Hazard/emergency lights: orange, blinking, at all 4 corners. Off
	// by default — toggled by the player, blink handled per-frame.
	//
	// AI cars (realHazards=false, the default): a pure unlit lens glow,
	// same reasoning as reverseLights above — a real car's hazard
	// blinkers don't illuminate the road either, they're a signal, not
	// a light source. AI cars in web mode run these permanently
	// blinking for the entire session (see setupWebAIExtras), so this
	// was the single biggest concentration of real always-cycling
	// dynamic lights in free-roam with several AI cars on screen at
	// once.
	//
	// The player's own car (realHazards=true): a real THREE.PointLight
	// per corner instead, same construction/settings as the taillights
	// above — just one car, so the earlier hang-risk reasoning doesn't
	// apply, and a real light actually looks lit up at the bump.
	const hazards = [];
	for ( const [ x, y, z ] of layout.hazards ) {

		const basePosition = anchoredPos( new THREE.Vector3( x, y, z ) );

		if ( realHazards ) {

			const baseDistance = 0.9;
			const baseIntensity = 0.8;
			const light = new THREE.PointLight( 0xff8c1a, baseIntensity, baseDistance, 2 );
			light.position.copy( basePosition );
			light.visible = false;
			anchorNode.add( light );
			hazards.push( { light, basePosition, baseDistance, baseIntensity } );
			continue;

		}

		const group = new THREE.Group();
		group.position.copy( basePosition );
		group.rotation.y = z > 0 ? 0 : Math.PI; // front bumps face forward, rear bumps face backward
		group.visible = false;
		anchorNode.add( group );

		const core = new THREE.Mesh(
			new THREE.CircleGeometry( 0.05, 12 ),
			new THREE.MeshBasicMaterial( { color: 0xff8c1a, toneMapped: false } )
		);
		group.add( core );

		const halo = new THREE.Mesh(
			new THREE.CircleGeometry( 0.14, 16 ),
			new THREE.MeshBasicMaterial( {
				map: createGlowTexture( '255, 140, 26' ), color: 0xff8c1a,
				transparent: true, toneMapped: false, depthWrite: false,
				blending: THREE.AdditiveBlending,
			} )
		);
		halo.position.z = -0.002;
		group.add( halo );

		hazards.push( { group, basePosition } );

	}

	return { headlights, taillights, hazards, headlightLenses, reverseLights };

}

// ─── Shared light control helpers (used by both modes) ─────

function toggleHeadlights( vehicleLights ) {

	if ( ! vehicleLights ) return;
	const on = ! vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights.headlights.forEach( ( h ) => { h.light.visible = on; } );
	if ( vehicleLights.headlightLenses ) {

		vehicleLights.headlightLenses.forEach( ( lens ) => { lens.visible = on; } );

	}

}

function toggleHazards( vehicleLights ) {

	if ( ! vehicleLights ) return;
	vehicleLights.hazardsOn = ! vehicleLights.hazardsOn;
	if ( ! vehicleLights.hazardsOn ) {

		// h.light for the player's real-PointLight hazards (see
		// addVehicleLights' realHazards param), h.group for AI cars'
		// unlit lens-glow version.
		vehicleLights.hazards.forEach( ( h ) => { if ( h.light ) h.light.visible = false; else h.group.visible = false; } );

	}

}

// High beam is held, not toggled — while held, headlights go brighter
// and farther-reaching (and force ON even if the player hadn't turned
// regular headlights on, matching a real high-beam flasher stalk).
function setHighBeam( vehicleLights, on, scale = 1 ) {

	if ( ! vehicleLights ) return;
	if ( vehicleLights._highBeamOn === on ) return; // no change, skip

	if ( on ) vehicleLights._headlightsBeforeHighBeam = vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights._highBeamOn = on;

	const s = Math.max( scale, 0.001 );
	const intensityScale = s;

	vehicleLights.headlights.forEach( ( h ) => {

		if ( on ) {

			h.light.visible = true;
			h.light.intensity = h.baseIntensity * intensityScale * 2.5;
			h.light.distance = h.baseDistance * s * 1.4;

		} else {

			h.light.intensity = h.baseIntensity * intensityScale;
			h.light.distance = h.baseDistance * s;
			h.light.visible = vehicleLights._headlightsBeforeHighBeam;

		}

	} );

	if ( vehicleLights.headlightLenses ) {

		const lensOn = on || vehicleLights._headlightsBeforeHighBeam;
		vehicleLights.headlightLenses.forEach( ( lens ) => {

			lens.visible = lensOn;
			lens.scale.setScalar( on ? 1.3 : 1 );

		} );

	}

}

// Call every frame; handles the hazard blink timing and keeps light
// range proportional to the vehicle's current scale (AR resize control) —
// a light's `.distance` is in local units and does NOT automatically
// scale with its parent's transform the way position/rotation do.
//
// `hazardScale` is vestigial for AI cars: their hazards (and every
// vehicle's reverseLights) are pure unlit lens-glow meshes, converted
// from real THREE.PointLights to cut down the number of real dynamic
// lights active at once — each one costs real per-pixel shader time in
// three.js's default forward lighting regardless of how dim/short-range
// it is, and with several AI cars hazard-blinking/reversing
// simultaneously that was a likely cause of reported stutter/hangs. Mesh
// geometry scales for free via the parent transform, so no per-light
// distance/intensity math is needed for those. The parameter stays in
// the signature only so every existing call site (which still passes
// it) doesn't need touching.
// The PLAYER's own car is the one exception (see addVehicleLights'
// realHazards param): its hazards ARE real PointLights again, same as
// its taillights, since a single car's worth of extra lights is
// negligible and looking properly lit matters more there. Handled below
// by the same real-vs-mesh branch already used for headlights/
// taillights vs reverseLights.
function updateVehicleLights( vehicleLights, dt, scale, isReversing = false, hazardScale = null ) {

	if ( ! vehicleLights ) return;

	// Every light's distance/intensity scales with the vehicle size —
	// not just headlights. Taillights are always-on, so at AR-tabletop
	// scale an unscaled ~0.9m range dwarfed the entire shrunk track,
	// washing the whole scene in red. Both distance and intensity scale
	// linearly with `scale` — matches how the same light would actually
	// look on a smaller physical car, and keeps brightness proportionate
	// to the AR track/arena rather than blowing it out.
	const s = Math.max( scale, 0.001 );
	const intensityScale = s;
	// Hazards use their OWN scale factor (see below) instead of `s` —
	// `hazardScale`, when the caller passes one, is the plain geometric
	// FIXED_SCALE for that AR mode (no extra headlight-style damping on
	// top, unlike `s`/`raceCtx.arScale`). Falls back to `s` itself when
	// no hazardScale is given (web mode's call site — nothing extra
	// layered on there). Room-drive AR passes its own boosted value
	// (gameState.vehicleScale * 3.2, see its call site) — per feedback
	// the base 0.9m/0.8-intensity hazard didn't read as a real light at
	// the car's normal 1:1 room-drive size.
	const hazS = Math.max( hazardScale !== null ? hazardScale : scale, 0.001 );

	if ( vehicleLights.headlights ) {

		vehicleLights.headlights.forEach( ( h ) => {

			h.light.distance = h.baseDistance * s;
			h.light.intensity = h.baseIntensity * intensityScale;

		} );

	}

	if ( vehicleLights.taillights ) {

		vehicleLights.taillights.forEach( ( t ) => {

			t.light.distance = t.baseDistance * s;
			t.light.intensity = t.baseIntensity * intensityScale;

		} );

	}

	// Reverse lights are a pure unlit lens glow now, not a real
	// THREE.PointLight — see addVehicleLights(). Visibility only; the
	// mesh's own size already scales correctly via the vehicle's parent
	// transform (AR resize/placement), unlike a real light's .distance/
	// .intensity which don't follow object scale and needed the manual
	// `s`/`intensityScale` math above.
	if ( vehicleLights.reverseLights ) {

		vehicleLights.reverseLights.forEach( ( r ) => {

			r.group.visible = isReversing;

		} );

	}

	// Hazards: AI cars use a pure unlit lens glow (see addVehicleLights())
	// which needs no per-frame distance/intensity math, just visibility.
	// The player's own car (realHazards=true) uses a real PointLight
	// instead, same construction as taillights above. Distance/intensity
	// scale with `hazS` (the plain geometric scale, see above) — NOT the
	// extra-damped `s` headlights/taillights use, and NOT left fully
	// unscaled either: undamped "web-strength" (0.9m/0.8 intensity) was
	// tried first and looked oversized — several times the size of the
	// whole tabletop car — since a real 0.9m light radius makes no sense
	// next to a ~15-20cm AR miniature. Scaling by the plain FIXED_SCALE
	// (same ratio the car model itself shrinks by) keeps the light's
	// size relative to the car identical to how it looks in web mode,
	// just correctly small there instead of room-illumination-sized.
	if ( vehicleLights.hazards && vehicleLights.hazards[ 0 ] && vehicleLights.hazards[ 0 ].light ) {

		vehicleLights.hazards.forEach( ( h ) => {

			h.light.distance = h.baseDistance * hazS;
			h.light.intensity = h.baseIntensity * hazS;

		} );

	}

	if ( vehicleLights.hazardsOn ) {

		vehicleLights._blinkTimer = ( vehicleLights._blinkTimer || 0 ) + dt;
		const on = Math.floor( vehicleLights._blinkTimer / 0.4 ) % 2 === 0;
		vehicleLights.hazards.forEach( ( h ) => { if ( h.light ) h.light.visible = on; else h.group.visible = on; } );

	}

}

// ─── Race countdown ─────────────────────────────────────────

function createCountdownUI() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-countdown {
			position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
			pointer-events: none;
		}
		#hw-countdown .cd-num {
			font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 120px; font-weight: 800; color: #fff;
			text-shadow: 0 0 30px rgba(91,140,255,0.8), 0 4px 12px rgba(0,0,0,0.6);
		}
	`;
	document.head.appendChild( style );

	const el = document.createElement( 'div' );
	el.id = 'hw-countdown';
	el.innerHTML = '<div class="cd-num"></div>';
	document.body.appendChild( el );

	return {
		numEl: el.querySelector( '.cd-num' ),
		set( text ) {

			this.numEl.textContent = text;
			this.numEl.animate(
				[ { transform: 'scale(1.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 } ],
				{ duration: 280, easing: 'ease-out' }
			);

		},
		remove() { el.remove(); },
	};

}

// ─── 3D race countdown (AR) ─────────────────────────────────
// AR's floating-menu cards proved a 2D DOM overlay reads as flat/out of
// place floating over a real-world passthrough scene — this is the same
// "3…2…1…GO!" countdown as createCountdownUI() above, but drawn as a real
// object in the 3D scene: a billboard sprite (always faces the camera,
// same trick as Three.js's own Sprite class) parented under the track's
// own transform group so it sits at a fixed spot above the track and
// shrinks/moves/rotates in sync with it automatically, with no manual
// per-frame placement math needed. Each digit change re-draws the same
// canvas (cheap — this only happens 4 times total per race: 3, 2, 1, GO!)
// and pops in with a quick scale-down-to-rest tween, driven by update(dt)
// every frame from the caller's own render loop.
function create3DRaceCountdown( parent, localPosition, scale = 6 ) {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx2d = canvas.getContext( '2d' );
	const texture = new THREE.CanvasTexture( canvas );

	function draw( text ) {

		ctx2d.clearRect( 0, 0, size, size );

		const glow = ctx2d.createRadialGradient( size / 2, size / 2, 0, size / 2, size / 2, size / 2 );
		glow.addColorStop( 0, 'rgba(91,140,255,0.38)' );
		glow.addColorStop( 0.55, 'rgba(139,95,191,0.18)' );
		glow.addColorStop( 1, 'rgba(139,95,191,0)' );
		ctx2d.fillStyle = glow;
		ctx2d.fillRect( 0, 0, size, size );

		ctx2d.textAlign = 'center';
		ctx2d.textBaseline = 'middle';
		ctx2d.font = `900 ${ text.length > 1 ? 92 : 148 }px 'Segoe UI', Tahoma, Arial, sans-serif`;
		ctx2d.lineWidth = 10;
		ctx2d.strokeStyle = 'rgba(8,7,14,0.85)';
		ctx2d.strokeText( text, size / 2, size / 2 + 6 );

		const textGrad = ctx2d.createLinearGradient( size * 0.15, 0, size * 0.85, 0 );
		textGrad.addColorStop( 0, '#8B5FBF' );
		textGrad.addColorStop( 0.5, '#5B8CFF' );
		textGrad.addColorStop( 1, '#4FD8E8' );
		ctx2d.fillStyle = textGrad;
		ctx2d.fillText( text, size / 2, size / 2 + 6 );

		texture.needsUpdate = true;

	}

	const material = new THREE.SpriteMaterial( { map: texture, transparent: true, depthWrite: false, toneMapped: false } );
	const sprite = new THREE.Sprite( material );
	sprite.position.copy( localPosition );
	sprite.scale.setScalar( scale );
	sprite.visible = false;
	parent.add( sprite );

	let popTimer = 0;

	return {
		set( text ) {

			draw( text );
			sprite.visible = true;
			popTimer = 0;

		},
		update( dt ) {

			if ( ! sprite.visible ) return;
			popTimer += dt;
			const t = Math.min( popTimer / 0.32, 1 );
			const eased = 1 - Math.pow( 1 - t, 3 );
			sprite.scale.setScalar( scale * ( 1.5 - 0.5 * eased ) );

		},
		remove() {

			parent.remove( sprite );
			material.map.dispose();
			material.dispose();

		},
	};

}

// ─── Fullscreen toggle (web mode only — an AR session already takes
// over the whole display, see the comment at the AR entry button). ────
// requestFullscreenSafe() already fires once automatically when picking
// a web mode from the menu, but that single attempt can silently fail
// (some mobile browsers are stricter about what counts as a "direct
// enough" gesture) or get backed out of later (OS gesture, alt-tab,
// notification pull-down) with no way back in — this is a persistent
// on-screen button so fullscreen can be (re)requested or exited at any
// point during play, not just once at the very start. Top-left corner:
// top-right is the lap timer's own corner (LapTimer.js), bottom-left is
// the touch controls dock below.
function setupFullscreenToggle() {

	// Same feature test as requestFullscreenSafe() — skip creating the
	// button at all on browsers with no Fullscreen API support (notably
	// iPhone Safari), since a button that could never do anything would
	// just be confusing clutter.
	const docEl = document.documentElement;
	const supported = !! ( docEl.requestFullscreen || docEl.webkitRequestFullscreen ||
		docEl.mozRequestFullScreen || docEl.msRequestFullscreen );
	if ( ! supported ) return;

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-fullscreen-btn {
			position: fixed; left: 14px; top: 14px; z-index: 30;
			width: 46px; height: 46px; border-radius: 50%; border: none; padding: 0;
			display: flex; align-items: center; justify-content: center;
			font-size: 19px; color: #fff;
			background: linear-gradient(165deg, rgba(32,20,54,0.72), rgba(13,13,22,0.72));
			border: 1px solid rgba(139,95,191,0.35);
			backdrop-filter: blur(6px);
			box-shadow: 0 6px 24px rgba(0,0,0,0.4);
			touch-action: manipulation; transition: background 0.12s, transform 0.08s;
		}
		#hw-fullscreen-btn:active {
			background: linear-gradient(135deg, #8B5FBF, #5B8CFF);
			transform: scale(0.94);
		}
	`;
	document.head.appendChild( style );

	const btn = document.createElement( 'button' );
	btn.id = 'hw-fullscreen-btn';
	document.body.appendChild( btn );

	function sync() {

		btn.textContent = isFullscreenActive() ? '✕' : '⛶';
		btn.title = isFullscreenActive() ? 'الخروج من ملء الشاشة' : 'ملء الشاشة';

	}

	// pointerdown (not click), same as the touch dock's own buttons: lower
	// latency, and stopPropagation keeps the tap from also registering as
	// a steering-zone touch (Controls.js's steer-zone covers the whole
	// screen underneath this button).
	btn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		if ( isFullscreenActive() ) exitFullscreenSafe();
		else requestFullscreenSafe();

	} );

	[ 'fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange' ]
		.forEach( ( evt ) => document.addEventListener( evt, sync ) );

	sync();

}

// Small floating toggle for the background music (bgMusic, started once
// per session on the first pointerdown/keydown — see startBgMusic() near
// the top of this file) — NORMAL/web mode only, same corner-button style
// as setupFullscreenToggle() just above but mirrored to the top-right so
// the two don't overlap.
function setupMusicToggle() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-music-btn {
			position: fixed; right: 14px; top: 14px; z-index: 30;
			width: 46px; height: 46px; border-radius: 50%; border: none; padding: 0;
			display: flex; align-items: center; justify-content: center;
			font-size: 19px; color: #fff;
			background: linear-gradient(165deg, rgba(32,20,54,0.72), rgba(13,13,22,0.72));
			border: 1px solid rgba(139,95,191,0.35);
			backdrop-filter: blur(6px);
			box-shadow: 0 6px 24px rgba(0,0,0,0.4);
			touch-action: manipulation; transition: background 0.12s, transform 0.08s;
		}
		#hw-music-btn:active {
			background: linear-gradient(135deg, #8B5FBF, #5B8CFF);
			transform: scale(0.94);
		}
	`;
	document.head.appendChild( style );

	const btn = document.createElement( 'button' );
	btn.id = 'hw-music-btn';
	document.body.appendChild( btn );

	function sync() {

		btn.textContent = bgMusic.muted ? '🔇' : '🔊';
		btn.title = bgMusic.muted ? 'تشغيل الموسيقى الخلفية' : 'إيقاف الموسيقى الخلفية';

	}

	// Muting (not pausing) keeps bgMusic's own loop/playback position
	// running, so unmuting resumes instantly in sync rather than
	// re-triggering the autoplay-unlock dance startBgMusic() guards against.
	btn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		bgMusic.muted = ! bgMusic.muted;
		sync();

	} );

	sync();

}

// ─── Touch controls dock (phones/tablets — no keyboard, no VR hands) ──
// Controls.js already covers a full-screen invisible steering zone for
// touch, so these buttons need a higher z-index to receive taps first.

function setupTouchUI( vehicleLights ) {

	if ( ! ( 'ontouchstart' in window ) ) return { highBeamHeld: false };

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-touch-dock {
			position: fixed; left: 14px; bottom: 14px; z-index: 30;
			display: flex; flex-direction: column; gap: 8px;
			padding: 10px 8px; border-radius: 20px;
			background: linear-gradient(165deg, rgba(32,20,54,0.72), rgba(13,13,22,0.72));
			border: 1px solid rgba(139,95,191,0.35);
			backdrop-filter: blur(6px);
			box-shadow: 0 6px 24px rgba(0,0,0,0.4);
		}
		#hw-touch-dock button {
			width: 50px; height: 50px; border-radius: 50%; border: none; padding: 0;
			background: rgba(255,255,255,0.06); color: #fff; font-size: 21px;
			display: flex; align-items: center; justify-content: center;
			touch-action: manipulation; transition: background 0.12s, transform 0.08s;
		}
		#hw-touch-dock button:active {
			background: linear-gradient(135deg, #8B5FBF, #5B8CFF);
			transform: scale(0.94);
		}
	`;
	document.head.appendChild( style );

	const wrap = document.createElement( 'div' );
	wrap.id = 'hw-touch-dock';

	function makeTapButton( label ) {

		const btn = document.createElement( 'button' );
		btn.textContent = label;
		return btn;

	}

	const homeBtn = makeTapButton( '🏠' );
	const headlightBtn = makeTapButton( '💡' );
	const hazardBtn = makeTapButton( '⚠️' );
	const highBeamBtn = makeTapButton( '🔆' );

	// Back to the main menu — added alongside the rest of this dock's
	// buttons per feedback that WEB mode (both track and free-roam, since
	// both call this same function) had no way back except reloading the
	// tab by hand. A plain navigation, no confirmation dialog — same
	// no-friction, single-tap pattern as every other button in this dock.
	homeBtn.title = 'الرجوع للقائمة الرئيسية';
	homeBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		location.href = location.pathname;

	} );

	// pointerdown (not click) for lower latency and to match the steering
	// zone's own event type; stopPropagation so the tap doesn't also get
	// picked up as a steering-zone touch.
	headlightBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		toggleHeadlights( vehicleLights );

	} );
	hazardBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		toggleHazards( vehicleLights );

	} );
	// High beam is a hold, not a tap — on while pressed, off on release.
	// Sets a flag rather than calling setHighBeam() directly: the
	// keyboard's own per-frame check (N key) was calling setHighBeam()
	// unconditionally every frame regardless of source, so on a
	// touch-only device (no keyboard) that per-frame call was always
	// "off" and immediately canceled whatever this button had just
	// turned on. The frame loop now combines both sources before calling
	// setHighBeam() once.
	const touchState = { highBeamHeld: false };
	highBeamBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		touchState.highBeamHeld = true;

	} );
	[ 'pointerup', 'pointerleave', 'pointercancel' ].forEach( ( evt ) => {

		highBeamBtn.addEventListener( evt, ( e ) => {

			e.stopPropagation();
			touchState.highBeamHeld = false;

		} );

	} );

	wrap.appendChild( homeBtn );
	wrap.appendChild( headlightBtn );
	wrap.appendChild( hazardBtn );
	wrap.appendChild( highBeamBtn );
	document.body.appendChild( wrap );

	return touchState;

}

// ─── Shared physics world setup (used by both modes) ──────

function createPhysicsWorld( gravityScale = 1 ) {

	const worldSettings = createWorldSettings();
	worldSettings.gravity = [ 0, - 9.81 * gravityScale, 0 ];

	// crashcat's own distance-based tolerances (speculative-contact
	// radius, allowed penetration slop, sleep-velocity threshold, …)
	// default to values tuned for roughly real-world-sized objects —
	// e.g. a 2cm penetrationSlop/speculativeContactDistance and a
	// 3cm/s sleep threshold. Both AR floating modes call this with
	// gravityScale = arTransform.scale (≈0.016), spawning a car whose
	// own radius shrinks to under a centimeter — smaller than those
	// default tolerances. The result: the car can rest half-buried in
	// the track/floor (penetrationSlop bigger than the whole car) and
	// gets treated as "at rest" and put to sleep almost immediately
	// (its whole achievable speed range sits under the 3cm/s sleep
	// threshold), which is exactly the "floating/sunk, then doesn't
	// move at all" symptom. Scaling every one of these by the same
	// factor keeps them proportional to the (also scaled) car instead
	// of proportional to a real-world car, and is a no-op at
	// gravityScale = 1 (every NORMAL-mode caller), so nothing changes
	// there.
	if ( gravityScale !== 1 ) {

		worldSettings.narrowphase.speculativeContactDistance *= gravityScale;
		worldSettings.narrowphase.manifoldTolerance *= gravityScale;
		worldSettings.contacts.contactPointPreserveLambdaMaxDistSq *= gravityScale * gravityScale;
		worldSettings.solver.penetrationSlop *= gravityScale;
		worldSettings.solver.maxPenetrationDistance *= gravityScale;
		worldSettings.sleeping.pointVelocitySleepThreshold *= gravityScale;

	}

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;

	return world;

}

// ─── Shared per-frame driving/game-object update, used by ──
// ─── both NORMAL and AR modes once a vehicle exists.       ──

function updateVehicleAndFx( dt, input, ctx ) {

	const { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener, vehicleFlag } = ctx;

	updateWorld( world, contactListener, dt );
	vehicle.update( dt, input );

	particles.update( dt, vehicle );
	driftMarks.update( dt, vehicle );
	audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity, vehicle.linearSpeed < -0.01 );
	if ( vehicle.justLaunched ) audio.playLaunch();
	if ( vehicleFlag ) vehicleFlag.updateFlutter( dt, Math.abs( vehicle.linearSpeed / MAX_SPEED ) );

	if ( lapTimer ) {

		const hasInput = input.touchActive || Math.abs( input.x ) > 0.05 || Math.abs( input.z ) > 0.05;
		lapTimer.update( dt, vehicle.spherePos, hasInput );

	}

}

// ─── AI opponents (real Vehicle physics, same as the player) ──
// Each AI gets its own Vehicle + sphere rigid body — the exact same
// class and physics the player drives with (sphere collider, suspension
// lean, wheel spin, drift). Steering/throttle are computed each frame
// from the direction to the next waypoint and fed in using the same
// "touch" input shape the game already uses for world-space-direction
// joystick control (see Controls.js/Vehicle.js), so movement quality
// matches the player's car and auto-gas naturally targets MAX_SPEED —
// giving genuinely competitive AI without extra speed tuning.

const TOTAL_RACE_LAPS = 3; // matches LapTimer.js's own TOTAL_LAPS

// Computes a 2-wide staggered starting grid behind the finish line —
// slot 0 is the player (front-left), slots 1+ are AI opponents.
function computeGridPositions( vehicleSpawn, count ) {

	const { position, angle } = vehicleSpawn;
	// Matches Vehicle.js's own forward-vector convention (see the same
	// note in Track.js's computeTrackPath) — NOT flipped. With the old
	// flipped vector, "position - forward*backDist" actually placed
	// slots AHEAD of the finish line (opposite of this function's own
	// "behind the finish line" comment) since -forward*backDist canceled
	// the flip back to +trueForward*backDist.
	const forward = { x: Math.sin( angle ), z: Math.cos( angle ) };
	const right = { x: forward.z, z: - forward.x };
	const rowSpacing = 3.2, colOffset = 0.8;

	const slots = [];
	for ( let i = 0; i < count; i ++ ) {

		const row = Math.floor( i / 2 );
		const col = ( i % 2 === 0 ) ? -1 : 1;
		const backDist = 2 + row * rowSpacing;

		const x = position[ 0 ] - forward.x * backDist + right.x * col * colOffset;
		const z = position[ 2 ] - forward.z * backDist + right.z * col * colOffset;

		slots.push( { position: [ x, position[ 1 ], z ], angle, backDist } );

	}

	return slots;

}

function createAIDrivers( npcConfigs, gridSlots, models, scene, world, path, radius = 0.5 ) {

	if ( ! path || path.length < 2 ) return [];

	// Average spacing between consecutive path points — used to convert
	// each grid slot's "how far back from the line" distance directly
	// into a starting path index, counting backward from index 0 (the
	// finish line). This avoids a plain nearest-point spatial search,
	// which could pick a point on the wrong side of the loop where the
	// start and end come back close together near the finish line,
	// sending that car off in the wrong direction from the start.
	let totalLen = 0;
	for ( let j = 0; j < path.length; j ++ ) {

		const a = path[ j ], b = path[ ( j + 1 ) % path.length ];
		totalLen += Math.hypot( b.x - a.x, b.z - a.z );

	}
	const avgSpacing = totalLen / path.length;

	return npcConfigs.map( ( cfg, i ) => {

		const slot = gridSlots[ i + 1 ]; // slot 0 is the player
		const sphereBody = createSphereBody( world, slot.position, radius );

		const vehicle = new Vehicle();
		vehicle.sphereRadius = radius;
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( slot.position[ 0 ], slot.position[ 1 ], slot.position[ 2 ] );
		vehicle.prevModelPos.set( slot.position[ 0 ], 0, slot.position[ 2 ] );
		vehicle.container.rotation.y = slot.angle;

		const model = models[ cfg.key ] || models[ 'vehicle-truck-yellow' ];
		const group = vehicle.init( model );
		group.scale.setScalar( radius / 0.5 ); // matches the player's own visual scale — 1 for NORMAL mode (radius=0.5), shrunk in AR contexts
		scene.add( group );

		const stepsBack = Math.round( slot.backDist / avgSpacing );
		const bestIdx = ( ( path.length - stepsBack ) % path.length + path.length ) % path.length;

		return {
			vehicle, idx: bestIdx,
			lapsCompleted: 0,
			finished: false,
			finishTime: null,
			stuckStrikes: 0,
			sampleTimer: 0,
			samplePos: { x: slot.position[ 0 ], z: slot.position[ 2 ] },
			// See the "Start-Zone Guard" in AIController.js's
			// updateRaceAIDrivers: cars start this close to path index 0
			// (just behind the finish line), so the first apparent
			// wrap-to-0 must NOT count as a completed lap until the car
			// has genuinely been driven through the middle of the track.
			hasLeftStartZone: false,
		};

	} );

}

// ─── Free-roam AI (random wandering "تفحيط" show, no fixed path) ──
// Unlike the race AI above, these don't follow a track — they just pick
// a random point inside the open arena, drive at it aggressively (full
// throttle, no easing off for the turn — the opposite of the race AI's
// cornering behavior), and pick a new random point every few seconds.
// The sharp steering at speed naturally induces the same drift the
// player's own car gets from Vehicle.js's physics, giving a "تفحيط
// show" look. No collision avoidance — bumping the boundary wall or
// another car is fine, even expected, for this look.

// roadHalfZ defaults to roadHalf so existing (square) callers spread AI
// exactly as before; a rectangular arena passes both independently so the
// spawn ring matches its actual footprint instead of a circle inscribed
// inside the shorter side.
function createFreeRoamAI( npcConfigs, models, scene, world, roadHalf, roadHalfZ = roadHalf ) {

	// Widened alongside updateFreeRoamAIDrivers' own wanderRadius (see
	// AIController.js) — these AI cars now spread across most of the
	// arena's radius from the start instead of clustering near its
	// center.
	const spawnMarginX = roadHalf * 0.85; // keep starting points away from the walls
	const spawnMarginZ = roadHalfZ * 0.85;

	return npcConfigs.map( ( cfg, i ) => {

		const angle = ( i / npcConfigs.length ) * Math.PI * 2;
		const distFrac = 0.3 + Math.random() * 0.65;
		const x = Math.cos( angle ) * spawnMarginX * distFrac;
		const z = Math.sin( angle ) * spawnMarginZ * distFrac;
		const heading = Math.random() * Math.PI * 2;

		const sphereBody = createSphereBody( world, [ x, 0.5, z ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( x, 0.5, z );
		vehicle.prevModelPos.set( x, 0, z );
		vehicle.container.rotation.y = heading;

		const model = models[ cfg.key ] || models[ 'vehicle-truck-yellow' ];
		const group = vehicle.init( model );
		scene.add( group );

		return {
			vehicle,
			target: { x, z }, // reached immediately, forces a fresh pick on frame 1
			retargetTimer: 0,
			stuckStrikes: 0,
			sampleTimer: 0,
			samplePos: { x, z },
		};

	} );

}


// Ranks player + AI by laps completed (then in-lap progress as a
// tiebreak) — used once the player finishes to produce final standings.
function computeStandings( drivers, path, playerFinishTime ) {

	const entries = [ {
		label: 'أنت', isPlayer: true,
		metric: TOTAL_RACE_LAPS,
		finishTime: playerFinishTime,
	} ];

	drivers.forEach( ( d, i ) => {

		const progress = path && path.length > 1 ? d.idx / path.length : 0;
		entries.push( {
			label: 'المتسابق ' + ( i + 1 ), isPlayer: false,
			metric: d.lapsCompleted + progress,
			finishTime: d.finishTime,
		} );

	} );

	entries.sort( ( a, b ) => {

		if ( a.finishTime !== null && b.finishTime !== null ) return a.finishTime - b.finishTime;
		if ( a.finishTime !== null ) return -1;
		if ( b.finishTime !== null ) return 1;
		return b.metric - a.metric;

	} );

	return entries;

}

function showRaceResultsOverlay( standings, { onRestart, onMenu } ) {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-race-results {
			position: fixed; inset: 0; z-index: 55; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.78); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
		}
		#hw-race-results .rr-card {
			max-width: 400px; width: 90%; padding: 28px 24px; border-radius: 20px; text-align: center;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-race-results .rr-title {
			font-size: 26px; font-weight: 800; margin-bottom: 18px;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
		}
		#hw-race-results .rr-row {
			display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-top: 1px solid rgba(255,255,255,0.08);
		}
		#hw-race-results .rr-row:first-of-type { border-top: none; }
		#hw-race-results .rr-pos { width: 26px; font-weight: 800; color: #9d8fd4; }
		#hw-race-results .rr-label { flex: 1; text-align: right; color: #fff; font-size: 14.5px; }
		#hw-race-results .rr-row.rr-me .rr-label { color: #5B8CFF; font-weight: 700; }
		#hw-race-results .rr-btns { display: flex; gap: 10px; margin-top: 20px; }
		#hw-race-results button {
			flex: 1; padding: 13px; border: none; border-radius: 999px; font-size: 14.5px; font-weight: 600; cursor: pointer;
		}
		#hw-race-results .rr-restart { background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; }
		#hw-race-results .rr-menu { background: rgba(255,255,255,0.08); color: #cfc9e0; }
	`;
	document.head.appendChild( style );

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-race-results';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="rr-card">
			<div class="rr-title">🏁 نتيجة السباق</div>
			${ standings.map( ( s, i ) => `
				<div class="rr-row ${ s.isPlayer ? 'rr-me' : '' }">
					<div class="rr-pos">${ i + 1 }</div>
					<div class="rr-label">${ s.label }</div>
				</div>
			` ).join( '' ) }
			<div class="rr-btns">
				<button class="rr-restart">إعادة السباق</button>
				<button class="rr-menu">الصفحة الرئيسية</button>
			</div>
		</div>
	`;
	document.body.appendChild( overlay );

	overlay.querySelector( '.rr-restart' ).addEventListener( 'click', () => { overlay.remove(); onRestart(); } );
	overlay.querySelector( '.rr-menu' ).addEventListener( 'click', () => { overlay.remove(); onMenu(); } );

}

// AI cars in web mode originally had no flag, lights, or drift marks at
// all. addVehicleLights() was wired in for all of them, but it builds a
// FULL light rig per car — 2 headlight spotlights + 2 lens glows + 2
// taillights + 2 reverse lights + 4 hazards, 10 lights total — and
// nothing ever toggles headlights/high-beam/reverse for an AI car, so 6
// of those 10 were dead weight just sitting in the scene graph, still
// costing the renderer a light slot every frame, for 3-4 AI cars at
// once. That's the likely cause of the reported heaviness/stutter on
// the web-mode track. What was actually asked for was the flag and the
// hazard/emergency lights ("العلم وإضاءات الطوارئ") — so headlights,
// their lens glows, taillights, and reverse lights are removed from the
// scene graph right after creation, keeping only the 4 hazard lights
// live. `addVehicleLights` itself is left untouched (still used by the
// player's own car, and by AR mode which legitimately wants the full
// rig) — this only strips the extra Object3Ds back out for AI-in-web.
//
// Also adds the drift/tire marks AI cars were still missing in web mode
// (present already in AR). A finite lifetime (fades after a few
// seconds) is used rather than web mode's usual Infinity+localStorage
// persistence — that persistent-trail-record feature is specifically
// about the player's own driving history, not meant to grow 3-4 more
// permanently-saved trails every session for cars nobody is steering.
function setupWebAIExtras( aiDrivers, idPrefix ) {

	const aiFlagUrl = createSaudiFlagDataUrl();
	const AI_DRIFT_MARK_LIFETIME = 4;

	return aiDrivers.map( ( d, i ) => {

		const lights = addVehicleLights( d.vehicle );
		lights.hazardsOn = true;
		lights.headlights.forEach( ( h ) => { h.light.removeFromParent(); h.target.removeFromParent(); } );
		lights.headlightLenses.forEach( ( lens ) => lens.removeFromParent() );
		lights.taillights.forEach( ( t ) => t.light.removeFromParent() );
		lights.reverseLights.forEach( ( r ) => r.group.removeFromParent() );

		const flag = addVehicleFlag( d.vehicle, aiFlagUrl );
		const driftMarks = new DriftMarks( scene, idPrefix + '-' + i, 1, AI_DRIFT_MARK_LIFETIME );

		return { lights, flag, driftMarks };

	} );

}

// ─── NORMAL MODE (unchanged behavior from the original game) ──

function startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } ) {

	const world = createPhysicsWorld();
	let sphereBody, vehicleSpawn, lapTimer = null;
	let trackPath = null, aiDrivers = [], aiExtras = [];
	let freeRoamHalf = 0;

	if ( freeRoam ) {

		// Open sandbox: no track, no walls — just a big flat ground.
		const groundSize = 110;

		// Night stadium look (matching a real "تفحيط" show — dark sky,
		// the floodlight poles below doing the actual lighting instead of
		// flat daylight). Scoped to free-roam only; the classic track
		// mode keeps its normal daylight scene.
		scene.background = new THREE.Color( 0x05060a );

		// A visible moon — otherwise the night sky was just a flat dark
		// color with no light source anyone could actually see, which
		// read as pure darkness rather than "night arena lit by
		// floodlights". Positioned far away and high up, unlit itself
		// (MeshBasicMaterial) so it reads as a glowing disc.
		const moon = new THREE.Mesh(
			new THREE.SphereGeometry( 6, 24, 24 ),
			new THREE.MeshBasicMaterial( { color: 0xe8ecf7 } )
		);
		moon.position.set( - groundSize * 0.6, groundSize * 0.5, - groundSize * 0.7 );
		scene.add( moon );
		scene.fog.color.set( 0x05060a );
		dirLight.intensity = 0.7; // moonlight fill, floodlights carry most of the scene
		hemiLight.intensity = 0.55;

		const roadHalf = groundSize / 2;

		scene.fog.near = groundSize * 0.5;
		scene.fog.far = groundSize * 1.1;

		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ 0, - 0.125, 0 ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Visible asphalt ground, matching the invisible physics floor.
		const asphaltTexture = createAsphaltTexture();
		asphaltTexture.repeat.set( groundSize / 8, groundSize / 8 );
		const groundMesh = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( { map: asphaltTexture, roughness: 1, metalness: 0 } )
		);
		groundMesh.rotation.x = - Math.PI / 2;
		groundMesh.position.set( 0, - 0.12, 0 );
		scene.add( groundMesh );

		// Solid perimeter walls so the car bounces off the edge instead of
		// driving past it and falling into the void — now with visible
		// grandstands (crowd included, Reem-circuit style) instead of an
		// invisible boundary.
		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallY = - 0.125 + wallHalfHeight;

		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( world, { // north/south (along X)
				shape: box.create( { halfExtents: [ roadHalf, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ 0, wallY, sign * roadHalf ],
				friction: 0.2,
				restitution: 0.3,
			} );

			rigidBody.create( world, { // east/west (along Z)
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, roadHalf ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ sign * roadHalf, wallY, 0 ],
				friction: 0.2,
				restitution: 0.3,
			} );

		}

		// Same red/white barrier style as the actual race track (and the
		// AR floating arena) instead of grandstands — keeps the visual
		// language consistent across web/AR and both arena variants.
		buildBarrierLoop( scene, null, roadHalf, roadHalf, - 0.125 );

		// Floodlight poles at the four corners, all aimed back at center —
		// the actual light source for the night-stadium look set above.
		const poleInset = roadHalf * 0.82;
		for ( const cx of [ -1, 1 ] ) {

			for ( const cz of [ -1, 1 ] ) {

				buildFloodlightPole( scene, cx * poleInset, cz * poleInset, { x: 0, z: 0 }, world );

			}

		}

		// Dry desert surround, peeking out beyond the paved arena's edge —
		// sits just below the asphalt so it only shows past its footprint.
		const sandTexture = createSandTexture();
		const sandSize = groundSize * 2;
		sandTexture.repeat.set( sandSize / 10, sandSize / 10 );
		const sandMesh = new THREE.Mesh(
			new THREE.PlaneGeometry( sandSize, sandSize ),
			new THREE.MeshStandardMaterial( { map: sandTexture, roughness: 1, metalness: 0 } )
		);
		sandMesh.rotation.x = - Math.PI / 2;
		sandMesh.position.set( 0, - 0.121, 0 );
		scene.add( sandMesh );

		// Burnout circles + drift trails, baked once across the whole
		// paved surface — a proper tiled texture would look obviously
		// repeated at this scale.
		const skidMarksTexture = createSkidMarksTexture( groundSize );
		const skidOverlay = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( {
				map: skidMarksTexture, transparent: true, roughness: 1,
				metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
			} )
		);
		skidOverlay.rotation.x = - Math.PI / 2;
		skidOverlay.position.set( 0, - 0.1195, 0 );
		scene.add( skidOverlay );

		// Racing curb (white edge line + red rumble-strip blocks), same
		// style as the actual race track, traced just inside this arena's
		// own barrier loop.
		const edgeTexture = createTrackEdgeTexture( groundSize, groundSize, roadHalf, roadHalf );
		const edgeOverlay = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( {
				map: edgeTexture, transparent: true, roughness: 0.9,
				metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
			} )
		);
		edgeOverlay.rotation.x = - Math.PI / 2;
		edgeOverlay.position.set( 0, - 0.119, 0 );
		scene.add( edgeOverlay );

		// Concrete barriers dressing the same line as the invisible
		// collision walls above (no extra physics needed — the collider's
		// already there). One gap left open on the +Z side for the
		// entrance gate.
		const barrierSeg = 8;
		for ( const sign of [ 1, -1 ] ) {

			for ( let p = - roadHalf; p < roadHalf; p += barrierSeg ) {

				const segLen = Math.min( barrierSeg, roadHalf - p ) - 0.3; // small gaps between segments, like real jersey barrier sections
				if ( segLen <= 0 ) continue;
				const center = p + segLen / 2;

				// Leave the entrance gate gap on the north wall (+Z, sign=1, axis 'x')
				if ( sign === 1 && Math.abs( center ) < 3 ) continue;

				buildBarrierSegment( scene, null, center, sign * roadHalf, segLen, 'x' );
				buildBarrierSegment( scene, null, sign * roadHalf, center, segLen, 'z' );

			}

		}

		buildEntranceGate( scene, 0, roadHalf, 'x' );

		// Tire stacks + parked decoration cars scattered near all 4
		// corners (randomized each time), warning signs flanking the gate.
		scatterCornerDecor( scene, models, roadHalf, roadHalf, [ 'vehicle-truck-green', 'vehicle-truck-black', 'vehicle-truck-red' ], world );
		buildWarningSign( scene, -4.5, roadHalf - 1, Math.PI );
		buildWarningSign( scene, 4.5, roadHalf - 1, Math.PI );

		// The AI roster (NPC_TRUCKS — camry, purple, red, camaro per the
		// current request) wanders/drifts here, same as everywhere else AI
		// cars spawn. Used to also hardcode an extra yellow entry on top of
		// NPC_TRUCKS ("free-roam has no [player-color] reservation"), but
		// that fought the "exclude yellow" request by re-adding it just for
		// this mode — dropped, so free-roam's AI roster matches every other
		// mode's exactly.
		aiDrivers = createFreeRoamAI(
			NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ),
			models, scene, world, roadHalf
		);
		freeRoamHalf = roadHalf;

		aiExtras = setupWebAIExtras( aiDrivers, 'web-freeroam-ai' );

		vehicleSpawn = { position: [ 0, 0.5, 0 ], angle: 0 };
		sphereBody = createSphereBody( world, vehicleSpawn.position );

	} else {

		// Compute track bounds and size physics to fit
		const bounds = computeTrackBounds( customCells );
		const hw = bounds.halfWidth;
		const hd = bounds.halfDepth;
		const groundSize = Math.max( hw, hd ) * 2 + 20;

		scene.fog.near = groundSize * 0.4;
		scene.fog.far = groundSize * 0.8;

		const { npcConfigs } = buildTrack( scene, models, customCells );
		trackPath = computeTrackPath( customCells );

		buildWallColliders( world, null, customCells );

		const roadHalf = groundSize / 2;
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ bounds.centerX, - 0.125, bounds.centerZ ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Starting grid: player at the front, AI staggered behind —
		// instead of the player spawning exactly on the line.
		let gridSpawn = spawn;
		if ( spawn && npcConfigs.length > 0 ) {

			const gridSlots = computeGridPositions( spawn, 1 + npcConfigs.length );
			gridSpawn = gridSlots[ 0 ];
			aiDrivers = createAIDrivers( npcConfigs, gridSlots, models, scene, world, trackPath );
			aiExtras = setupWebAIExtras( aiDrivers, 'web-race-ai' );

		}

		vehicleSpawn = gridSpawn;
		sphereBody = createSphereBody( world, gridSpawn ? gridSpawn.position : null );
		lapTimer = new LapTimer( customCells, mapParam );

	}

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

	if ( vehicleSpawn ) {

		const [ sx, sy, sz ] = vehicleSpawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = vehicleSpawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
	scene.add( vehicleGroup );
	addCustomTextDecals( vehicleGroup, customText );
	const vehicleLights = addVehicleLights( vehicle, true ); // true: this is the player's own car — real hazard lights
	// flagImage comes from the main menu's image picker (a data: URL, see
	// createModeMenu) — falls back to the placeholder banner in Flag.js
	// if the player didn't pick one.
	const vehicleFlag = addVehicleFlag( vehicle, flagImage );

	dirLight.target = vehicleGroup;

	// Free-roam ("الحلبة") pulls the chase cam back so a much larger part
	// of the open arena is visible at once, instead of the classic track
	// mode's tighter, closer-in default view.
	const cam = freeRoam ? new Camera( { distanceScale: 3, far: 250, near: 2 } ) : new Camera();
	scene.add( cam.debug );

	const controls = new Controls();

	const particles = new SmokeTrails( scene );
	// AI cars share ONE dedicated, deliberately light smoke emitter — same
	// idea as the AR floating-track/arena fix that stopped the smoke
	// freeze (real-world scale here, so scale stays 1, only emitMultiplier
	// is cut) — separate from the player's own full-strength `particles`
	// so AI stays a light background effect rather than competing with it.
	const aiParticles = new SmokeTrails( scene, 1, 0.15 );
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	const touchState = setupTouchUI( vehicleLights );
	setupFullscreenToggle();
	setupMusicToggle();

	const _forward = new THREE.Vector3();
	const _camLead = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			audio.playImpact( impactVelocity );

		}
	};

	const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener, vehicleFlag };

	// Light controls for NORMAL mode (no VR controllers here, so keyboard
	// instead): L = headlights, H = hazards. Edge-detected so holding a
	// key doesn't rapid-fire.
	let prevKeys = { l: false, h: false };

	// Race start countdown — only for an actual track with a finish line
	// (not free-roam). Controls stay locked until it reaches zero.
	const isRace = !! ( lapTimer && lapTimer.enabled );
	const raceState = { phase: isRace ? 'countdown' : 'racing', countdown: 3, countdownTimer: 0, totalTime: 0 };
	let countdownUI = isRace ? createCountdownUI() : null;
	if ( countdownUI ) countdownUI.set( String( raceState.countdown ) );
	let resultsShown = false;

	if ( isRace ) {

		lapTimer.onFinish = () => { raceState.phase = 'finished'; };

	}

	return {

		frameUpdate( dt ) {

			if ( raceState.phase === 'countdown' ) {

				raceState.countdownTimer += dt;
				if ( raceState.countdownTimer >= 1 ) {

					raceState.countdownTimer -= 1;
					raceState.countdown -= 1;

					if ( raceState.countdown > 0 ) {

						countdownUI.set( String( raceState.countdown ) );

					} else {

						countdownUI.set( 'GO!' );
						raceState.phase = 'racing';
						setTimeout( () => { if ( countdownUI ) { countdownUI.remove(); countdownUI = null; } }, 500 );

					}

				}

			} else if ( raceState.phase !== 'countdown' ) {

				// Keep advancing after the player finishes too (phase
				// 'finished'), not just during 'racing' — see the
				// aiRacing note below for why this must not freeze.
				raceState.totalTime += dt;

			}

			const racing = raceState.phase === 'racing';
			const rawInput = controls.update();
			const input = racing ? rawInput : { x: 0, z: 0, touchActive: false };

			updateVehicleAndFx( dt, input, ctx );
			if ( isRace ) {

				// IMPORTANT: do NOT gate the AI update on `racing`. The
				// player's own LapTimer can (and often does) finish their
				// 3 laps before slower AI drivers finish theirs — `racing`
				// flips to false the instant raceState.phase becomes
				// 'finished', which zeroes every AI driver's input and
				// freezes it wherever it happens to be (looked like "AI
				// stops after 2 laps" whenever the player finished first).
				// Each AI already stops itself once IT personally reaches
				// TOTAL_RACE_LAPS (d.finished, checked inside
				// updateRaceAIDrivers) — so only the pre-race countdown
				// should hold them back, not the player crossing the line.
				const aiRacing = raceState.phase !== 'countdown';
				updateRaceAIDrivers( aiDrivers, trackPath, dt, aiRacing, raceState.totalTime, vehicle );

			} else {

				updateFreeRoamAIDrivers( aiDrivers, dt, freeRoamHalf );

			}

			// AI cars' hazard-blink timing, flag flutter, and drift/tire
			// marks — same per-frame update the player's own car gets, just
			// applied to each AI car's own { lights, flag, driftMarks }
			// from aiExtras above.
			for ( let i = 0; i < aiDrivers.length; i ++ ) {

				const extra = aiExtras[ i ];
				if ( ! extra ) continue;
				const d = aiDrivers[ i ];
				updateVehicleLights( extra.lights, dt, 1, d.vehicle.linearSpeed < -0.01 );
				if ( extra.flag ) extra.flag.updateFlutter( dt, Math.abs( d.vehicle.linearSpeed / MAX_SPEED ) );
				if ( extra.driftMarks ) extra.driftMarks.update( dt, d.vehicle );
				aiParticles.update( dt, d.vehicle );

			}

			updateVehicleLights( vehicleLights, dt, 1, vehicle.linearSpeed < -0.01 );

			if ( raceState.phase === 'finished' && ! resultsShown ) {

				resultsShown = true;
				const standings = computeStandings( aiDrivers, trackPath, raceState.totalTime );
				showRaceResultsOverlay( standings, {
					onRestart: () => {

						// Stash this race's settings so init() can skip the mode
						// menu on reload and jump straight back into the same
						// race/track/car. See the matching read+consume logic
						// near the top of init() (sessionStorage key 'hwRestartRace').
						try {

							sessionStorage.setItem( 'hwRestartRace', JSON.stringify( { customText, freeRoam, vehicleKey, flagImage } ) );

						} catch ( e ) { /* ignore — falls back to showing the menu again */ }
						location.reload();

					},
					onMenu: () => { location.href = location.pathname; },
				} );

			}

			const lKey = !! controls.keys[ 'KeyL' ];
			const hKey = !! controls.keys[ 'KeyH' ];
			const nKey = !! controls.keys[ 'KeyN' ];
			if ( lKey && ! prevKeys.l ) toggleHeadlights( vehicleLights );
			if ( hKey && ! prevKeys.h ) toggleHazards( vehicleLights );
			setHighBeam( vehicleLights, nKey || touchState.highBeamHeld );
			audio.setHorn( !! controls.keys[ 'Space' ] );
			prevKeys = { l: lKey, h: hKey };

			dirLight.position.set(
				vehicle.spherePos.x + 11.4,
				15,
				vehicle.spherePos.z - 5.3
			);

			const mv = vehicle.modelVelocity;
			_camLead.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).multiplyScalar( Math.sqrt( mv.x * mv.x + mv.z * mv.z ) );
			cam.update( dt, vehicle.spherePos, _camLead );

			renderer.render( scene, cam.camera );

		}

	};

}

// ─── AR MODE (Meta Quest 3 passthrough) ────────────────────

// ─── AR floating track ───────────────────────────────────────
// The default track, built exactly like NORMAL mode, but grabbable/
// movable/scalable instead of fixed in place. No AI opponents yet — single car, kept
// simple for this first working version.
//
// Physics note: crashcat's rigid bodies live in absolute world space,
// completely disconnected from a THREE.Object3D's own transform — so a
// real physics car wouldn't follow the track being grabbed/moved/resized
// at all. Instead the car is a plain child of trackGroup with simple
// kinematic movement (position/heading updated directly, no rigid body),
// entirely in the group's local space — Three.js's normal parent-child
// transform inheritance then makes it automatically move/scale with the
// track for free, no extra bookkeeping needed. It trades away momentum/
// suspension/drift physics for correctness under a moving reference
// frame; can revisit if that trade turns out to matter in practice.

// ─── AR floating 3D mode menu ───────────────────────────────
// Shown immediately on entering AR — three pointable/selectable cards
// (room-drive / floating track / floating arena), replacing the old
// flat pre-session sub-screen. Selection uses controller pointing
// (raycasting, the natural VR/AR menu interaction) + trigger to
// confirm, rather than the grab mechanic used elsewhere (grabbing
// implies "pick this up", which doesn't fit "choose one of these
// options").
const modeCardLoader = new THREE.TextureLoader();
const modeCardTextures = {};
for ( const key of [ 'room', 'track', 'arena' ] ) {

	modeCardTextures[ key ] = modeCardLoader.load(
		`models/Textures/mode-${ key }.jpeg`,
		( t ) => { t.colorSpace = THREE.SRGBColorSpace; },
		undefined,
		( err ) => console.error( `[main] mode card texture failed to load: mode-${ key }.jpeg`, err )
	);

}

function createModeCard( textureKey ) {

	// Portrait aspect ratio matching the source images (≈469:768) — title
	// text is already baked into the image itself, so no canvas text
	// overlay needed here.
	return new THREE.Mesh(
		new THREE.PlaneGeometry( 0.22, 0.36 ),
		new THREE.MeshBasicMaterial( { map: modeCardTextures[ textureKey ], side: THREE.DoubleSide } )
	);

}

// Returns a Promise resolving to 'room' | 'track' | 'arena'.
function showFloatingModeMenu( arManager, scene ) {

	return new Promise( ( resolve ) => {

		const options = [ 'room', 'track', 'arena' ];

		const menuGroup = new THREE.Group();
		scene.add( menuGroup );

		const cards = options.map( ( id, i ) => {

			const card = createModeCard( id );
			// Centered around x=0 regardless of how many options there are
			// (was a flat `(i - 1) * 0.26`, only correct for exactly 3).
			card.position.set( ( i - ( options.length - 1 ) / 2 ) * 0.26, 0, 0 );
			card.userData.optionId = id;
			card.userData.baseScale = 1;
			menuGroup.add( card );
			return card;

		} );

		const light = new THREE.PointLight( 0xffffff, 2, 3 );
		scene.add( light );

		// Eye-level follow: a fixed y=1.2 read as "too high" or "too low"
		// depending on the person's actual height/posture, since it had
		// nothing to do with where their headset actually was. Recomputed
		// every frame from the real XR camera pose instead — position.y
		// matches real eye height exactly, x/z sit a fixed distance ahead
		// along the camera's current horizontal facing (pitch/roll from
		// looking up/down ignored, so the panel stays upright rather than
		// tilting with the headset), and lookAt (menu and camera at the
		// same y) naturally comes out level with no extra tilt math needed.
		const _mmCamPos = new THREE.Vector3();
		const _mmCamQuat = new THREE.Quaternion();
		const _mmFwd = new THREE.Vector3();
		function followEyeLevel( dt ) {

			const cam = renderer.xr.getCamera();
			cam.getWorldPosition( _mmCamPos );
			cam.getWorldQuaternion( _mmCamQuat );
			_mmFwd.set( 0, 0, -1 ).applyQuaternion( _mmCamQuat );
			_mmFwd.y = 0;
			if ( _mmFwd.lengthSq() < 1e-6 ) _mmFwd.set( 0, 0, -1 );
			_mmFwd.normalize();

			menuGroup.position.set( _mmCamPos.x + _mmFwd.x * 0.8, _mmCamPos.y, _mmCamPos.z + _mmFwd.z * 0.8 );
			menuGroup.lookAt( _mmCamPos.x, _mmCamPos.y, _mmCamPos.z );

			light.position.set( _mmCamPos.x + _mmFwd.x * 0.5, _mmCamPos.y, _mmCamPos.z + _mmFwd.z * 0.5 );

		}

		const raycaster = new THREE.Raycaster();
		const tmpDir = new THREE.Vector3();
		const prevTrigger = { left: false, right: false };
		let resolved = false;

		function cleanup() {

			scene.remove( menuGroup );
			scene.remove( light );

		}

		this._floatingMenuUpdate = ( dt ) => {

			if ( resolved ) return;

			followEyeLevel( dt );

			let hoveredCard = null;

			for ( const hand of [ 'left', 'right' ] ) {

				const controller = arManager.controllers[ hand ];
				const gp = arManager.gamepads[ hand ];
				if ( ! controller || ! gp ) continue;

				tmpDir.set( 0, 0, - 1 ).applyQuaternion( controller.quaternion );
				raycaster.set( controller.position, tmpDir );
				const hits = raycaster.intersectObjects( cards );

				const trig = gp.buttons[ 0 ] ? gp.buttons[ 0 ].pressed : false;
				const trigEdge = trig && ! prevTrigger[ hand ];
				prevTrigger[ hand ] = trig;

				if ( hits.length > 0 ) {

					hoveredCard = hits[ 0 ].object;
					if ( trigEdge ) {

						resolved = true;
						cleanup();
						resolve( hoveredCard.userData.optionId );
						return;

					}

				}

			}

			cards.forEach( ( c ) => {

				const targetScale = ( c === hoveredCard ) ? 1.15 : 1;
				c.scale.setScalar( THREE.MathUtils.lerp( c.scale.x, targetScale, Math.min( 1, dt * 10 ) ) );

			} );

		};

	} );

}

// ─── AR entry orchestrator ──────────────────────────────────
// One session is requested here (with hit-test available for all three
// modes, even though only room-drive currently uses it — simpler than
// branching the session's requiredFeatures before the person has even
// picked a mode). The floating 3D menu runs first; once they choose,
// control hands off to whichever mode's own start function, reusing
// this same connected arManager instead of each opening its own session.
//
// Returns its frameUpdate wrapper immediately (not after the person has
// chosen) — the main loop only calls frameUpdate on whatever this
// function already returned, so waiting on the menu's choice here
// first would mean nothing ever drives the menu's own per-frame
// update, and the choice would never come.
// Simple two-card confirm shown when the Menu button is pressed —
// "رجوع لأوضاع AR" ends the current AR sub-mode (track/arena/room) and
// returns to the AR track/arena/room picker, NOT the game's main
// pre-AR menu (see openExitConfirm's hwReturnToArMenu stash in
// startARWithFloatingMenu); "إلغاء" just dismisses. Reuses the same
// pointing+trigger interaction as the mode-selection menu.
function showExitConfirm( arManager, scene ) {

	return new Promise( ( resolve ) => {

		const group = new THREE.Group();
		scene.add( group );

		// Same eye-level follow as showFloatingModeMenu above — see its
		// comment for why a fixed y=1.2 was wrong.
		const _ecCamPos = new THREE.Vector3();
		const _ecCamQuat = new THREE.Quaternion();
		const _ecFwd = new THREE.Vector3();
		function followEyeLevel() {

			const cam = renderer.xr.getCamera();
			cam.getWorldPosition( _ecCamPos );
			cam.getWorldQuaternion( _ecCamQuat );
			_ecFwd.set( 0, 0, -1 ).applyQuaternion( _ecCamQuat );
			_ecFwd.y = 0;
			if ( _ecFwd.lengthSq() < 1e-6 ) _ecFwd.set( 0, 0, -1 );
			_ecFwd.normalize();

			group.position.set( _ecCamPos.x + _ecFwd.x * 0.6, _ecCamPos.y, _ecCamPos.z + _ecFwd.z * 0.6 );
			group.lookAt( _ecCamPos.x, _ecCamPos.y, _ecCamPos.z );

		}

		function makeCard( text, color ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = 512; canvas.height = 200;
			const ctx = canvas.getContext( '2d' );
			ctx.fillStyle = color;
			ctx.fillRect( 0, 0, 512, 200 );
			ctx.fillStyle = '#fff';
			ctx.font = 'bold 44px "Segoe UI", Tahoma, Arial, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.direction = 'rtl';
			ctx.fillText( text, 256, 100 );
			const texture = new THREE.CanvasTexture( canvas );
			texture.colorSpace = THREE.SRGBColorSpace;
			return new THREE.Mesh(
				new THREE.PlaneGeometry( 0.26, 0.1 ),
				new THREE.MeshBasicMaterial( { map: texture, side: THREE.DoubleSide } )
			);

		}

		const exitCard = makeCard( 'رجوع لأوضاع AR', '#C0392B' );
		exitCard.position.set( - 0.15, 0, 0 );
		exitCard.userData.action = 'exit';
		const cancelCard = makeCard( 'إلغاء', '#3A3A40' );
		cancelCard.position.set( 0.15, 0, 0 );
		cancelCard.userData.action = 'cancel';
		group.add( exitCard, cancelCard );

		const cards = [ exitCard, cancelCard ];
		const raycaster = new THREE.Raycaster();
		const tmpDir = new THREE.Vector3();
		const prevTrigger = { left: false, right: false };
		let resolved = false;

		function update( dt ) {

			if ( resolved ) return;

			followEyeLevel();

			let hovered = null;

			for ( const hand of [ 'left', 'right' ] ) {

				const controller = arManager.controllers[ hand ];
				const gp = arManager.gamepads[ hand ];
				if ( ! controller || ! gp ) continue;

				tmpDir.set( 0, 0, - 1 ).applyQuaternion( controller.quaternion );
				raycaster.set( controller.position, tmpDir );
				const hits = raycaster.intersectObjects( cards );

				const trig = gp.buttons[ 0 ] ? gp.buttons[ 0 ].pressed : false;
				const trigEdge = trig && ! prevTrigger[ hand ];
				prevTrigger[ hand ] = trig;

				if ( hits.length > 0 ) {

					hovered = hits[ 0 ].object;
					if ( trigEdge ) {

						resolved = true;
						scene.remove( group );
						resolve( hovered.userData.action );
						return;

					}

				}

			}

			cards.forEach( ( c ) => {

				const target = ( c === hovered ) ? 1.15 : 1;
				c.scale.setScalar( THREE.MathUtils.lerp( c.scale.x, target, Math.min( 1, dt * 10 ) ) );

			} );

		}

		showExitConfirm._update = update;

	} );

}

// Real in-scene 3D prompt for the AR floating-track race-finish screen —
// same eye-level-follow + controller-raycast + trigger mechanic as
// showExitConfirm above (its own closure state, so the two never fight
// over each other's `_update` stash). Built specifically to replace the
// previous "end the XR session, then show the game's normal 2D results
// overlay via .finally()" approach, which was reported to crash with an
// on-screen error — this frameUpdate kept calling renderer.render() the
// same tick session.end() was triggered, while the session was still
// mid-teardown. Staying fully in-scene sidesteps that: nothing about the
// session changes until the player actually picks one of these two cards.
function showAR3DRaceResults( arManager, scene, standings ) {

	return new Promise( ( resolve ) => {

		const group = new THREE.Group();
		scene.add( group );

		const _rrCamPos = new THREE.Vector3();
		const _rrCamQuat = new THREE.Quaternion();
		const _rrFwd = new THREE.Vector3();
		function followEyeLevel() {

			const cam = renderer.xr.getCamera();
			cam.getWorldPosition( _rrCamPos );
			cam.getWorldQuaternion( _rrCamQuat );
			_rrFwd.set( 0, 0, -1 ).applyQuaternion( _rrCamQuat );
			_rrFwd.y = 0;
			if ( _rrFwd.lengthSq() < 1e-6 ) _rrFwd.set( 0, 0, -1 );
			_rrFwd.normalize();

			group.position.set( _rrCamPos.x + _rrFwd.x * 0.6, _rrCamPos.y, _rrCamPos.z + _rrFwd.z * 0.6 );
			group.lookAt( _rrCamPos.x, _rrCamPos.y, _rrCamPos.z );

		}

		function makeCard( text, color, w, h, fontSize ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = 512; canvas.height = 200;
			const ctx = canvas.getContext( '2d' );
			ctx.fillStyle = color;
			ctx.fillRect( 0, 0, 512, 200 );
			ctx.fillStyle = '#fff';
			ctx.font = `bold ${ fontSize }px "Segoe UI", Tahoma, Arial, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.direction = 'rtl';
			ctx.fillText( text, 256, 100 );
			const texture = new THREE.CanvasTexture( canvas );
			texture.colorSpace = THREE.SRGBColorSpace;
			return new THREE.Mesh(
				new THREE.PlaneGeometry( w, h ),
				new THREE.MeshBasicMaterial( { map: texture, side: THREE.DoubleSide, transparent: true } )
			);

		}

		const winnerLabel = standings && standings[ 0 ] ? standings[ 0 ].label : '';
		const titleText = winnerLabel ? `🏁 الفائز: ${ winnerLabel }` : '🏁 انتهى السباق';
		const title = makeCard( titleText, '#15131f', 0.46, 0.11, 32 );
		title.position.set( 0, 0.13, 0 );
		group.add( title );

		const restartCard = makeCard( 'إعادة السباق', '#1F7A4C', 0.26, 0.1, 38 );
		restartCard.position.set( - 0.15, 0, 0 );
		restartCard.userData.action = 'restart';

		const menuCard = makeCard( 'رجوع لأوضاع AR', '#3A3A40', 0.26, 0.1, 38 );
		menuCard.position.set( 0.15, 0, 0 );
		menuCard.userData.action = 'menu';

		group.add( restartCard, menuCard );

		const cards = [ restartCard, menuCard ];
		const raycaster = new THREE.Raycaster();
		const tmpDir = new THREE.Vector3();
		const prevTrigger = { left: false, right: false };
		let resolved = false;

		function update( dt ) {

			if ( resolved ) return;

			followEyeLevel();

			let hovered = null;

			for ( const hand of [ 'left', 'right' ] ) {

				const controller = arManager.controllers[ hand ];
				const gp = arManager.gamepads[ hand ];
				if ( ! controller || ! gp ) continue;

				tmpDir.set( 0, 0, - 1 ).applyQuaternion( controller.quaternion );
				raycaster.set( controller.position, tmpDir );
				const hits = raycaster.intersectObjects( cards );

				const trig = gp.buttons[ 0 ] ? gp.buttons[ 0 ].pressed : false;
				const trigEdge = trig && ! prevTrigger[ hand ];
				prevTrigger[ hand ] = trig;

				if ( hits.length > 0 ) {

					hovered = hits[ 0 ].object;
					if ( trigEdge ) {

						resolved = true;
						scene.remove( group );
						resolve( hovered.userData.action );
						return;

					}

				}

			}

			cards.forEach( ( c ) => {

				const target = ( c === hovered ) ? 1.15 : 1;
				c.scale.setScalar( THREE.MathUtils.lerp( c.scale.x, target, Math.min( 1, dt * 10 ) ) );

			} );

		}

		showAR3DRaceResults._update = update;

	} );

}

// Small persistent floating icon, always available during any AR mode —
// a genuine alternative to the physical Menu button, which turned out
// unreachable via WebXR on the browsers tested (reserved by the system
// for its own menu). Positioned low and off to one side so it doesn't
// sit in the middle of the view, but still reachable by pointing at it.
function createFloatingHomeButton( scene ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 200; canvas.height = 200;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#2a2a30';
	ctx.beginPath();
	ctx.arc( 100, 100, 96, 0, Math.PI * 2 );
	ctx.fill();
	ctx.strokeStyle = 'rgba(255,255,255,0.6)';
	ctx.lineWidth = 4;
	ctx.stroke();
	// Simple house icon
	ctx.strokeStyle = '#fff';
	ctx.lineWidth = 10;
	ctx.lineJoin = 'round';
	ctx.beginPath();
	ctx.moveTo( 60, 105 ); ctx.lineTo( 100, 70 ); ctx.lineTo( 140, 105 );
	ctx.stroke();
	ctx.strokeRect( 72, 100, 56, 45 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;

	const button = new THREE.Mesh(
		new THREE.CircleGeometry( 0.055, 24 ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true, side: THREE.DoubleSide } )
	);
	button.position.set( - 0.35, 0.9, - 0.6 );
	scene.add( button );

	return button;

}

async function startARWithFloatingMenu( { mapParam, customCells, customText, vehicleKey, flagImage, sessionPromise } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	await arManager.requestSession( sessionPromise );

	// Bloom is authored for a single flat camera and doesn't handle
	// WebXR's per-eye stereo rendering correctly — also directly
	// responsible for bright lights blowing out into an overwhelming
	// glow, since bloom amplifies bright pixels heavily.
	renderer.setEffects( [] );
	// Fires on ANY session end, not just the ones this file triggers
	// itself. openExitConfirm() and showAR3DRaceResults() below both call
	// arManager.session.end() from inside the app and handle their own
	// stash+reload back to the AR mode picker — but a WebXR session can
	// also end from OUTSIDE the app entirely (the headset's own "exit AR"
	// system gesture, taking the headset off long enough to auto-end the
	// session, an underlying WebXR error) with no in-app trigger at all.
	// Previously that case had no handler at all: ARManager.update()
	// already no-ops once session is null, but each submode's own
	// frameUpdate() kept calling renderer.render() every frame regardless
	// — meaning the page would just sit frozen on the last AR frame with
	// no way back, instead of returning to the menu the way an
	// intentional exit does. Doing the same stash+reload here
	// unconditionally covers that case too; on the two explicit exit
	// paths this fires redundantly alongside their own reload, which is
	// harmless (the second reload call is a no-op once the page is
	// already navigating away).
	arManager.session.addEventListener( 'end', () => {

		renderer.setEffects( [ bloomPass ] );

		try {

			sessionStorage.setItem( 'hwReturnToArMenu', JSON.stringify( { customText, vehicleKey, flagImage } ) );

		} catch ( e ) { /* ignore — falls back to the game's main menu */ }

		window.location.reload();

	} );

	const placeholderCamera = new THREE.PerspectiveCamera();
	const menuCtx = {};

	// "إعادة السباق" from the floating-track finish screen stashes this
	// (see showAR3DRaceResults' resolution in startARFloatingTrack) so the
	// AR mode picker below is skipped entirely on the post-reload re-entry
	// — straight back into 'track' instead of making the player re-pick
	// it. Any other entry path (menu button, exit-confirm, first-ever AR
	// entry) leaves this unset and gets the normal picker.
	let autoRestartId = null;
	try {

		autoRestartId = sessionStorage.getItem( 'hwArAutoRestart' );
		if ( autoRestartId ) sessionStorage.removeItem( 'hwArAutoRestart' );

	} catch ( e ) { autoRestartId = null; }

	const choicePromise = autoRestartId
		? Promise.resolve( autoRestartId )
		: showFloatingModeMenu.call( menuCtx, arManager, scene );

	let subMode = null; // set once the chosen mode's own async setup resolves
	let switching = false;
	let exitConfirmActive = false;

	// Persistent floating home button — created now but only checked for
	// interaction once actually driving (subMode set), since the mode
	// menu and exit-confirm already have their own dedicated flows.
	const homeButton = createFloatingHomeButton( scene );
	let homeButtonDwell = 0;
	const HOME_BUTTON_RANGE = 0.1;
	const HOME_BUTTON_DWELL_TIME = 0.4; // seconds of holding a controller near it

	choicePromise.then( async ( chosenId ) => {

		switching = true;

		try {

			if ( chosenId === 'track' ) {

				subMode = await startARFloatingTrack( { arManager, vehicleKey, customText, flagImage, customCells } );

			} else if ( chosenId === 'arena' ) {

				subMode = await startARFloatingArena( { arManager, vehicleKey, customText, flagImage } );

			} else {

				subMode = await startARMode( { arManager, mapParam, customText, vehicleKey, flagImage } );

			}

		} catch ( e ) {

			console.error( '[main] AR mode setup after floating menu failed:', e );

		}

	} );

	function openExitConfirm() {

		exitConfirmActive = true;

		// While this confirm menu is up, frameUpdate below skips
		// subMode.frameUpdate() entirely (see the `if ( exitConfirmActive )`
		// early-return further down) — so nothing ever calls audio.update()
		// to ramp the engine/skid/etc. loops down, and they're left playing
		// at whatever volume/pitch they last had, seemingly stuck, until
		// the menu closes. Suspending the AudioContext itself (the same
		// mechanism Audio.js already uses to pause on tab-hide) silences
		// everything immediately without touching any per-mode state.
		const exitAudioCtx = subMode && subMode.audio && subMode.audio.listener.context;
		if ( exitAudioCtx && exitAudioCtx.state === 'running' ) exitAudioCtx.suspend();

		showExitConfirm( arManager, scene ).then( ( action ) => {

			exitConfirmActive = false;
			if ( action === 'exit' ) {

				// A full reload rather than just session.end() — the
				// game has no existing teardown path for its internal
				// state (physics world, vehicle, audio, etc.) once an
				// AR mode is active, so a bare session end would leave
				// activeMode pointing at now-defunct XR objects. This
				// is the same "start clean" pattern every mode
				// transition already relies on.
				//
				// Stashed here (same sessionStorage-handoff pattern as
				// "إعادة السباق") so init() can skip the FULL main menu
				// after reload and land back on the AR track/arena/room
				// picker instead — this button is "back to the AR modes",
				// not "back to the game's very first screen". A fresh
				// user gesture is still required to re-request a WebXR
				// session (browsers won't allow that automatically after
				// a reload), so init() shows one small "re-enter AR"
				// button rather than skipping straight back in.
				try {

					sessionStorage.setItem( 'hwReturnToArMenu', JSON.stringify( { customText, vehicleKey, flagImage } ) );

				} catch ( e ) { /* ignore */ }

				arManager.session.end().finally( () => window.location.reload() );

			} else if ( exitAudioCtx && exitAudioCtx.state === 'suspended' ) {

				// 'cancel' — driving resumes, so sound should too.
				exitAudioCtx.resume();

			}

		} );

	}

	return {

		frameUpdate( dt, timestamp, frame ) {

			// Menu (☰) button — see getMenuButtonPress()'s own comment on
			// why this may simply never fire depending on the browser.
			if ( ! exitConfirmActive && arManager.getMenuButtonPress() ) openExitConfirm();

			// Floating home button — proximity + a short dwell time
			// (no button press needed) rather than pointing+trigger,
			// since trigger/grip are already claimed by throttle/horn
			// during driving and would otherwise fire both at once.
			// Repositioned every frame relative to the headset (like a
			// HUD element) — a fixed world position could end up out of
			// comfortable reach if the person moved around the room
			// after it was first placed.
			if ( ! exitConfirmActive && subMode ) {

				const cam = renderer.xr.getCamera();
				const camPos = new THREE.Vector3();
				const camQuat = new THREE.Quaternion();
				cam.getWorldPosition( camPos );
				cam.getWorldQuaternion( camQuat );
				const offset = new THREE.Vector3( -0.25, -0.15, -0.5 ).applyQuaternion( camQuat );
				homeButton.position.copy( camPos ).add( offset );
				homeButton.quaternion.copy( camQuat );

				let near = false;
				for ( const hand of [ 'left', 'right' ] ) {

					const controller = arManager.controllers[ hand ];
					if ( controller && controller.position.distanceTo( homeButton.position ) <= HOME_BUTTON_RANGE ) near = true;

				}

				if ( near ) {

					homeButtonDwell += dt;
					const t = Math.min( 1, homeButtonDwell / HOME_BUTTON_DWELL_TIME );
					homeButton.scale.setScalar( 1 + t * 0.3 );
					if ( homeButton.material ) homeButton.material.opacity = 0.6 + t * 0.4;
					if ( homeButtonDwell >= HOME_BUTTON_DWELL_TIME ) {

						homeButtonDwell = 0;
						homeButton.scale.setScalar( 1 );
						openExitConfirm();

					}

				} else {

					homeButtonDwell = 0;
					homeButton.scale.setScalar( 1 );
					if ( homeButton.material ) homeButton.material.opacity = 0.85;

				}

			}

			if ( exitConfirmActive ) {

				if ( showExitConfirm._update ) showExitConfirm._update( dt );
				renderer.render( scene, placeholderCamera );
				return;

			}

			if ( subMode ) {

				subMode.frameUpdate( dt, timestamp, frame );
				return;

			}

			if ( ! switching && menuCtx._floatingMenuUpdate ) menuCtx._floatingMenuUpdate( dt );
			renderer.render( scene, placeholderCamera );

		}

	};

}

async function startARFloatingTrack( { arManager, vehicleKey, customText, flagImage, customCells } ) {

	// STAGE 1 (placement) + STAGE 2 (rebuild): place + lock the track,
	// then spawn a full-featured real-physics car on it — same feature
	// set as room-drive AR mode (lights, flag, text, smoke, drift marks,
	// audio, horn), just at the track's fixed AR scale instead of
	// a user-resizable one.
	// Hit-test IS used (see the placing phase in frameUpdate below, via
	// arManager.updateExternalPlacement()) — just not ARManager's own
	// generic ring/arrow previewGroup, since the actual track itself
	// (arRoot) is the preview here.
	arManager.previewGroup.visible = false;

	const placeholderCamera = new THREE.PerspectiveCamera();
	// customCells (from a track made in the editor, via ?map=) is threaded
	// through the exact same way NORMAL/web mode already uses it — this
	// used to always pass null here (forcing the built-in TRACK_CELLS
	// regardless of what was loaded), which is why a custom track worked
	// in web mode but silently reverted to the default track in AR.
	const { trackGroup, npcConfigs } = buildTrack( scene, models, customCells, { skipDeco: true } );
	const spawn = computeSpawnPosition( customCells );
	const bounds = computeTrackBounds( customCells || TRACK_CELLS );
	const trackPath = computeTrackPath( customCells );
	let totalTime = 0;

	// ✏️ EASY RETUNING KNOBS — both are purely cosmetic/pacing, safe to
	// tweak freely without touching physics stability (mass, gravity, and
	// the real 0.5m collision radius are never touched by either of
	// them):
	//  - FIXED_SCALE: how big the whole tabletop track appears (smaller
	//    number = smaller footprint on the table). This is now the ONLY
	//    size knob — a previous per-car CAR_VISUAL_BOOST hack (rendering
	//    the car's model bigger than its real hitbox) was removed after
	//    feedback that it made car sizes inconsistent: the player car,
	//    the AI cars (boosted the same way), and the arena's own parked
	//    decoration cars (never boosted, since they're not "the car" —
	//    just static dressing) all ended up at three different relative
	//    sizes on the same tabletop. Every car-shaped object here — the
	//    player, the AI racers, and the decoration cars in the arena's
	//    corners — is now rendered at its real, unboosted, 1:1 size, and
	//    ALL of them are parented under the one wrapping transform group
	//    (arRoot / arenaGroup) that FIXED_SCALE is applied to. That
	//    guarantees every car on the table shares the exact same
	//    proportions relative to the track/arena and to each other,
	//    which is exactly how NORMAL/web mode already works — this is
	//    that same approach, not a new one.
	//  - TIME_SCALE: the actual fix for "the car feels slow" — a real
	//    car driven at real speed, shrunk to fit on a table but viewed
	//    from the player's own REAL (unshrunk) eye distance, is a
	//    textbook "miniature effect": the same physical motion covers a
	//    proportionally tiny slice of your field of view, so it reads as
	//    slow-motion no matter how fast the physics itself says the car
	//    is going — the car's true speed never changed, only how far
	//    away it looks from being shrunk. This is the same reasoning
	//    film miniature work uses in reverse (full-size scenes shot to
	//    look tiny are sped up so they read as toy-scale) — here it's
	//    already toy-scale, so simulation TIME itself is sped up instead
	//    to make it read as full-speed again. Applied only to the
	//    physics/AI/particle updates below (see simDt), never to input
	//    reading or blink timers, so controls/UI still feel responsive
	//    at a normal rate.
	// Bumped up (0.02 → 0.026 → 0.033, ~27% this time) per feedback that
	// the car still read small — this is the ONE shared knob (see the
	// CAR_VISUAL_BOOST removal note above): it scales arRoot as a whole,
	// so car, track, and every decoration piece all grow together,
	// keeping their relative proportions exactly as they were instead of
	// just the car alone getting bigger (which is what caused the
	// original car/AI/decoration size-mismatch bug this session started
	// by fixing) — the car looks bigger, but its size relative to the
	// track stays identical to before.
	const FIXED_SCALE = 0.033;
	// Reset to the game's base speed (1 = identical pacing to NORMAL/web
	// mode) — an earlier 2.5x was tuned to fix a reported "feels slow"
	// issue at very small AR scale, but overshot and read as sped-up.
	const TIME_SCALE = 1;
	// How long (seconds) a tire/drift mark stays on the ground before
	// fading out — much shorter than NORMAL mode's permanent record,
	// since the user reported marks lingering too long in AR.
	const DRIFT_MARK_LIFETIME = 4;
	// Extra headlight dimming specific to this AR mode, on top of
	// FIXED_SCALE's own size-based scaling. updateVehicleLights()/
	// setHighBeam() scale a light's distance AND intensity linearly by
	// whatever `scale` they're given, but physically-based inverse-square
	// falloff (decay=2 on the SpotLight itself, see addVehicleLights()'s
	// baseIntensity comment) means brightness right next to the source
	// stays extreme regardless of that scale — and the AR track is viewed
	// from real, close-up distance, unlike NORMAL/web mode's own headlight
	// use where the car is far from camera. Feedback was specifically
	// that headlights stayed too strong here even after the shared
	// baseIntensity cut (which mainly fixed web mode, since web's scale=1
	// applies no reduction at all) — this multiplies FIXED_SCALE down
	// further, ONLY for this mode's lights (raceCtx.arScale below is used
	// exclusively for lighting, nothing else, so it's safe to bake the
	// extra factor directly into it here).
	const AR_LIGHT_DAMPING = 0.35;

	// arRoot carries the AR placement (position/rotation/scale) as one
	// clean transform. trackGroup goes underneath it UNCHANGED — still
	// carrying buildTrack()'s own internal position.y=-0.5 and
	// scale=GRID_SCALE(0.75), which is what aligns its child pieces
	// with the wall/ground physics formulas in the first place (those
	// formulas already bake in that same -0.5/0.75 as absolute NORMAL-
	// mode coordinates). Overwriting trackGroup's own transform instead
	// of wrapping it was fighting that baseline on two fronts at once —
	// scale (fixed previously) and Y-position (this fix): mixing MY
	// arbitrary AR position into the same transform as that internal
	// -0.5 pushed the visual track's Y out of sync with where the wall/
	// ground colliders (which assume that -0.5 stays exactly as-authored)
	// actually ended up.
	const arRoot = new THREE.Group();
	scene.add( arRoot );
	arRoot.add( trackGroup );

	// Position/rotation are no longer a fixed guess — see the placing-
	// phase in frameUpdate below, which drives arRoot from the same
	// real-surface hit-test the room-drive AR mode uses (ARManager's
	// updateExternalPlacement()), so the track lands on an actual
	// detected table/floor instead of floating at a hardcoded distance.
	// Hidden until the first surface hit lands.
	arRoot.scale.setScalar( FIXED_SCALE );
	arRoot.visible = false;

	const light = new THREE.DirectionalLight( 0xffffff, 3 );
	light.position.set( 0.6, 1, 0.6 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	// Fill light from the opposite side — softens the side of the car
	// facing away from `light` above instead of it reading pure black.
	const fillLight = new THREE.DirectionalLight( 0xffffff, 0.22 );
	fillLight.position.set( -0.6, 0.5, -0.6 );
	scene.add( fillLight );

	// See ensureAREnvironment()'s own comment (top of file) — gives the
	// car's PBR materials real reflections instead of the flat/dull look
	// with no environment set. AR-only.
	ensureAREnvironment();

	// dirLight (module-level, top of file) is created once at page load
	// and stays visible/full intensity (3) forever unless something turns
	// it off — nothing did for this mode, so it was double-lighting the
	// scene on top of this mode's own purpose-built `light` above. `light`
	// + the ambient above are the actual intended lighting for this tiny
	// AR scene, so dirLight is switched off entirely here instead. Page
	// reload on exit (see the exit handler below) restores it for the
	// next mode.
	dirLight.visible = false;

	let raceCtx = null;
	let confirmed = false;

	function lockInTrack() {

		try {

			// Track stays exactly where/how big it is from this point on —
			// real physics colliders are built to match THIS transform once
			// (crashcat's rigid bodies live in absolute world space, not
			// arRoot's own transform, so they'd desync from any further
			// grab — which is why resize/move are locked at this stage).
			// Physics now runs at REAL scale — the exact same numbers as
			// NORMAL/web mode (real 9.81 gravity, real 0.5m car radius,
			// real track dimensions), instead of the previous approach of
			// shrinking the whole physics simulation down to tabletop
			// size. A millimeter-scale rigid-body sim fights crashcat's
			// own distance tolerances (collision margins, sleep
			// thresholds) and Vehicle.js's own driving-feel constants
			// (suspension, grip, drift thresholds) — both tuned in
			// real-world units — which is what caused the reported "car
			// behaves oddly" symptom (floating/sinking, jitter, erratic
			// handling), even after earlier attempts to patch around it by
			// scaling those tolerances down too (see createPhysicsWorld's
			// own comment). `arRoot` already does the one thing actually
			// needed for the AR "tabletop" look — a pure VISUAL
			// scale+placement transform — so simulating underneath it at
			// full scale and simply parenting the car under `arRoot` (see
			// vehicleGroup below) lets three.js handle the shrink
			// automatically, with no manual coordinate scaling anywhere in
			// this function — exactly how NORMAL mode's own track/car
			// coordinates already work, just wrapped in one extra parent
			// transform for placement.
			const world = createPhysicsWorld();
			buildWallColliders( world, null, customCells );

			// Same ground-collider sizing as NORMAL mode's own track
			// branch (see startNormalMode): padded well beyond the track's
			// own footprint so the car can't drive off the edge into the
			// void.
			const groundSize = Math.max( bounds.halfWidth, bounds.halfDepth ) * 2 + 20;
			const roadHalf = groundSize / 2;
			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ bounds.centerX, - 0.125, bounds.centerZ ],
				friction: 5.0,
				restitution: 0.0,
			} );

			// Real 0.5m car radius — createSphereBody's own NORMAL-mode
			// default, no AR-specific scaling. Full grid (player + AI
			// opponents), same layout NORMAL mode's own track branch uses.
			const gridSlots = computeGridPositions( spawn, 1 + npcConfigs.length );
			const gridSlot = gridSlots[ 0 ];
			const sphereBody = createSphereBody( world, gridSlot.position );

			const vehicle = new Vehicle();
			vehicle.rigidBody = sphereBody;
			vehicle.physicsWorld = world;
			vehicle.spawnPos = gridSlot.position;
			vehicle.spawnAngle = gridSlot.angle;
			vehicle.spherePos.set( gridSlot.position[ 0 ], gridSlot.position[ 1 ], gridSlot.position[ 2 ] );
			vehicle.prevModelPos.set( gridSlot.position[ 0 ], 0, gridSlot.position[ 2 ] );
			vehicle.container.rotation.y = gridSlot.angle;

			const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
			// Parented under arRoot (not scene) — vehicle.container.position
			// is set directly from spherePos each frame (see Vehicle.js),
			// which is now in the SAME real-scale "track-local" coordinate
			// system trackGroup's own pieces already use underneath arRoot.
			// arRoot's own scale+placement transform therefore shrinks and
			// places the car exactly in sync with the track, automatically,
			// every frame — no per-spawn or per-frame coordinate transform
			// needed at all.
			arRoot.add( vehicleGroup );
			addCustomTextDecals( vehicleGroup, customText );
			const vehicleLights = addVehicleLights( vehicle, true ); // true: this is the player's own car — real hazard lights
			const vehicleFlag = addVehicleFlag( vehicle, flagImage );
			// Real-world meters, same as vehicleLights' own position values
			// above — arRoot's single shrink transform scales this down in
			// sync with everything else, no extra scale math needed here.
			addARContactShadow( vehicleGroup );

			const audio = new GameAudio();
			audio.init( renderer.xr.getCamera(), vehicleGroup );
			audio.forceUnlock();

			// Smoke IS scaled for AR (going back to the game's plain default
			// caused the reported freeze/hang before the track even fully
			// rendered) — Particles.js authors particle size in real
			// world-first meters (BASE_SIZE=1), and these particles are
			// added straight to `scene` rather than nested under `arRoot`,
			// so at scale=1 each puff rendered close to a full meter wide —
			// several times bigger than the whole (FIXED_SCALE-shrunk) car.
			// Passing FIXED_SCALE * 0.7 here keeps every puff visibly
			// smaller than the car, proportional to it instead of dwarfing
			// it. emitMultiplier is also cut hard (0.15, well below the
			// previous 0.3) since this ONE particle pool is shared across
			// the player AND all 3 AI every frame (see the AI loop below) —
			// four cars all emitting into the same fixed-size pool at
			// default emission rate is exactly what caused the freeze.
			const particles = new SmokeTrails( scene, FIXED_SCALE * 0.7, 0.15 );
			// AI now gets its own separate, even-lighter pool instead of
			// sharing the player's — per feedback that AI smoke should be
			// lighter everywhere. Splitting it out also removes the AI cars'
			// share of load from the player's own pool.
			const aiParticles = new SmokeTrails( scene, FIXED_SCALE * 0.7, 0.06 );
			// Drift marks fade out after DRIFT_MARK_LIFETIME seconds instead
			// of staying forever — appropriate for AR (a live tabletop
			// scene, not a persisted record like NORMAL mode's track), and
			// also skips the localStorage persistence NORMAL mode relies on
			// (a faded mark has no age info, so it would come back at full
			// strength on reload otherwise). NORMAL/room-AR mode's own
			// DriftMarks calls are untouched — they keep the default
			// Infinity lifetime and their permanent saved record.
			const driftMarks = new DriftMarks( scene, 'ar-floating-track', FIXED_SCALE, DRIFT_MARK_LIFETIME );

			const _forward = new THREE.Vector3();
			const contactListener = {
				onContactAdded( bodyA, bodyB ) {

					if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;
					_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
					_forward.y = 0;
					_forward.normalize();
					const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
					audio.playImpact( impactVelocity );

				}
			};

			const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer: null, contactListener, vehicleFlag };

			// Player lap timer — the SAME LapTimer class NORMAL/web mode's
			// own track race uses (finish-line crossing detection, 3-lap
			// counting, best-lap storage), wired in via ctx.lapTimer so
			// updateVehicleAndFx() above drives it automatically every
			// frame exactly like web mode, with no separate call needed
			// here. Previously this stayed `null` (see ctx above), so the
			// player's own laps were never tracked in AR at all — only the
			// AI silently raced against a finish line the player's car
			// couldn't cross. Its small top-right HUD is a 2D DOM element
			// (LapTimer.js's own buildUI()) that now actually renders
			// during the AR session thanks to the 'dom-overlay' feature
			// added to the immersive-ar session request.
			const lapTimer = new LapTimer( customCells, 'ar-floating-track' );
			ctx.lapTimer = lapTimer;

			// AI opponents — the exact same real Vehicle physics as the
			// player (createAIDrivers is NORMAL mode's own function,
			// reused unchanged), parented under arRoot (passed in place of
			// `scene`) so they shrink/place in sync automatically exactly
			// like the player. No radius override now (defaults to the
			// real 0.5m / scale=1) — same reasoning as removing
			// CAR_VISUAL_BOOST above: AI cars stay the exact same real
			// size as the player and the arena's decoration cars, all
			// governed by the one FIXED_SCALE transform.
			const aiDrivers = createAIDrivers( npcConfigs, gridSlots, models, arRoot, world, trackPath );
			// AI flags always fly this fixed Saudi Arabia flag — never the
			// player's own flagImage — and don't change if the player
			// changes theirs. Flutter is driven every frame below (AI
			// flags were previously created but never animated — only the
			// player's own updateVehicleAndFx() call did that).
			const aiFlagUrl = createSaudiFlagDataUrl();
			const aiExtras = aiDrivers.map( ( d, i ) => {

				const lights = addVehicleLights( d.vehicle );
				lights.hazardsOn = true; // AI always shows hazard/emergency blinkers
				const flag = addVehicleFlag( d.vehicle, aiFlagUrl );
				const marks = new DriftMarks( scene, 'ar-floating-track-ai-' + i, FIXED_SCALE, DRIFT_MARK_LIFETIME );
				return { lights, driftMarks: marks, flag };

			} );

			// Pre-race countdown + lap-race state machine — same
			// 'countdown' → 'racing' → 'finished' phases as NORMAL/web
			// mode's own track race (see startNormalMode), but the
			// countdown itself is a real 3D object floating above the
			// start line (create3DRaceCountdown, above) instead of a flat
			// 2D corner overlay — a screen-space countdown read oddly over
			// a real passthrough view. isRace mirrors LapTimer's own
			// `enabled` check (false only if the loaded track has no
			// finish-line cell), so a finish-line-less custom track keeps
			// its previous behavior (AI loops immediately, no countdown/
			// results for the player) instead of stalling forever waiting
			// for a race that can't finish.
			const isRace = !! lapTimer.enabled;
			const raceState = { phase: isRace ? 'countdown' : 'racing', countdown: 3, countdownTimer: 0, totalTime: 0 };
			const countdown3D = isRace
				? create3DRaceCountdown( arRoot, new THREE.Vector3( spawn.position[ 0 ], 6, spawn.position[ 2 ] ), 6 )
				: null;
			if ( countdown3D ) countdown3D.set( String( raceState.countdown ) );
			if ( isRace ) lapTimer.onFinish = () => { raceState.phase = 'finished'; };

			raceCtx = {
				world, vehicle, vehicleGroup, vehicleLights, audio, ctx, aiDrivers, aiExtras, aiParticles,
				arScale: FIXED_SCALE * AR_LIGHT_DAMPING,
				lapTimer, isRace, raceState, countdown3D, resultsShown: false,
			};

		} catch ( e ) {

			console.error( '[main] floating-track lock-in failed:', e );
			showErrorOverlay(
				( e && e.message ) ? e.message : String( e ),
				e && e.stack ? e.stack : '',
				() => window.location.reload(),
				'تعذّر تثبيت المضمار — السيارة لم تُنشأ'
			);

		}

	}

	const controls = new Controls();

	return {

		// undefined until raceCtx is populated (placement locked in) — the
		// outer exit-confirm flow (startARWithFloatingMenu) uses this to
		// suspend/resume the AudioContext while its menu is open, same
		// approach Audio.js already uses for tab-visibility pausing.
		get audio() { return raceCtx && raceCtx.audio; },

		frameUpdate( dt, timestamp, frame ) {

			// The finish-screen 'restart'/'menu' choice has already kicked off
			// arManager.session.end() — stop touching the renderer entirely
			// from here on (this exact frameUpdate calling renderer.render()
			// on the same tick session.end() fired was the previous
			// crash-with-on-screen-error report; see showAR3DRaceResults'
			// resolution below).
			if ( raceCtx && raceCtx.leavingSession ) return;

			try {

				if ( ! confirmed ) {

					// Same hit-test surface search + thumbstick nudge + trigger
					// confirm as the room-drive AR mode's own placement screen
					// (ARManager.updateExternalPlacement — see its comment) —
					// the track stays hidden and glued to the camera's search
					// until a real surface (table, floor, …) is found, then
					// follows that surface (with thumbstick fine-adjustment)
					// until the trigger is pulled.
					const { hasHit, confirmEdge } = arManager.updateExternalPlacement( frame, dt );

					arRoot.visible = hasHit;

					if ( hasHit ) {

						// hit-test gives "which way is away from the player, on
						// the detected surface" as arQuaternion — spawn.angle is
						// then composed on top (a further LOCAL yaw) so the
						// track's own start gate still faces the same relative
						// direction it always has, exactly like the previous
						// fixed `rotation.y = spawn.angle` did, just now applied
						// on top of a real detected surface pose instead of a
						// guessed fixed one.
						arRoot.position.copy( arManager.arPosition );
						arRoot.quaternion.copy( arManager.arQuaternion );
						arRoot.rotateY( spawn.angle );

					}

					if ( confirmEdge ) {

						confirmed = true;
						lockInTrack();

					}

				} else if ( raceCtx ) {

					// The finish-screen 3D prompt (showAR3DRaceResults) is up —
					// freeze the race entirely and just drive/render that
					// prompt until the player picks an action, same pattern
					// startARWithFloatingMenu's own exitConfirmActive uses.
					if ( raceCtx.resultsActive ) {

						if ( showAR3DRaceResults._update ) showAR3DRaceResults._update( dt );
						renderer.render( scene, placeholderCamera );
						return;

					}

					// Advance the pre-race countdown on real `dt` (not
					// simDt) — same reasoning as NORMAL mode's own
					// countdown: UI timing should feel immediate, not sped
					// up by TIME_SCALE. Mirrors startNormalMode's raceState
					// machine exactly, just driving a 3D sprite instead of
					// a DOM element.
					if ( raceCtx.isRace ) {

						const rs = raceCtx.raceState;
						if ( rs.phase === 'countdown' ) {

							rs.countdownTimer += dt;
							if ( rs.countdownTimer >= 1 ) {

								rs.countdownTimer -= 1;
								rs.countdown -= 1;

								if ( rs.countdown > 0 ) {

									if ( raceCtx.countdown3D ) raceCtx.countdown3D.set( String( rs.countdown ) );

								} else {

									if ( raceCtx.countdown3D ) raceCtx.countdown3D.set( 'GO!' );
									rs.phase = 'racing';
									setTimeout( () => { if ( raceCtx.countdown3D ) { raceCtx.countdown3D.remove(); raceCtx.countdown3D = null; } }, 500 );

								}

							}

						} else if ( rs.phase !== 'countdown' ) {

							// Keeps advancing after the player finishes too
							// ('finished'), not just during 'racing' — same
							// reasoning as NORMAL mode: AI opponents still
							// racing shouldn't freeze the clock.
							rs.totalTime += dt;

						}

						if ( raceCtx.countdown3D ) raceCtx.countdown3D.update( dt );

					}

					const racing = ! raceCtx.isRace || raceCtx.raceState.phase === 'racing';
					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = racing ? {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					} : { x: 0, z: 0, touchActive: false, handbrake: false };
					// simDt (not dt) drives physics/AI/particles/drift-marks
					// — see the TIME_SCALE comment above for why: a real
					// car at real speed, shrunk to fit a table but viewed
					// from the player's real (unshrunk) eye distance,
					// reads as slow motion no matter what the physics says
					// — this is what actually fixes that. Input reading,
					// UI, and light-toggle edge detection above stay on
					// real `dt` since those should still feel immediate.
					const simDt = dt * TIME_SCALE;
					updateVehicleAndFx( simDt, input, raceCtx.ctx );
					updateVehicleLights( raceCtx.vehicleLights, dt, raceCtx.arScale, raceCtx.vehicle.linearSpeed < -0.01, FIXED_SCALE );

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( raceCtx.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( raceCtx.vehicleLights );
					setHighBeam( raceCtx.vehicleLights, arManager.getHighBeamHold(), raceCtx.arScale );
					raceCtx.audio.setHorn( arManager.getHornHold() );
					if ( arManager.getMusicToggle() ) bgMusic.muted = ! bgMusic.muted;

					// AI opponents: same real pure-pursuit driving as
					// NORMAL mode's own race AI, plus the same lights/
					// flag/smoke/drift-marks the player gets. Smoke reuses
					// the player's own SmokeTrails instance (one shared
					// particle pool/draw call for everyone, cheaper than a
					// separate instance per car) — drift marks stay
					// per-car since each needs its own continuous trail.
					// Driven by the same simDt as the player so the AI
					// keeps pace instead of visually lagging behind a
					// player who now moves 2.5× faster in sim-time.
					totalTime += simDt;
					// Only the pre-race countdown holds the AI back now —
					// once the player finishes ('finished' phase) the AI
					// keep racing to their own TOTAL_RACE_LAPS instead of
					// freezing (same bug/fix as NORMAL mode's own aiRacing
					// note: gating on `racing` here would zero every AI's
					// input the instant the player crosses the line first).
					const aiRacing = ! raceCtx.isRace || raceCtx.raceState.phase !== 'countdown';
					updateRaceAIDrivers( raceCtx.aiDrivers, trackPath, simDt, aiRacing, totalTime, raceCtx.vehicle );
					raceCtx.aiDrivers.forEach( ( d, i ) => {

						const extra = raceCtx.aiExtras[ i ];
						raceCtx.aiParticles.update( simDt, d.vehicle );
						extra.driftMarks.update( simDt, d.vehicle );
						updateVehicleLights( extra.lights, dt, raceCtx.arScale, d.vehicle.linearSpeed < -0.01, FIXED_SCALE );
						if ( extra.flag ) extra.flag.updateFlutter( simDt, Math.abs( d.vehicle.linearSpeed / MAX_SPEED ) );

					} );

					if ( raceCtx.isRace && raceCtx.raceState.phase === 'finished' && ! raceCtx.resultsShown ) {

						raceCtx.resultsShown = true;
						raceCtx.resultsActive = true;
						const standings = computeStandings( raceCtx.aiDrivers, trackPath, raceCtx.raceState.totalTime );

						// Real in-AR 3D prompt (same raycaster+trigger mechanic
						// as showExitConfirm) instead of ending the session and
						// showing the game's normal 2D DOM overlay — that
						// approach was reported to crash with an on-screen
						// error, because this same frameUpdate kept calling
						// renderer.render() on the tick session.end() fired,
						// while the session was still mid-teardown. Nothing
						// about the session changes now until the player
						// actually picks one of the two cards below.
						showAR3DRaceResults( arManager, scene, standings ).then( ( action ) => {

							// Same sessionStorage handoff openExitConfirm's own
							// "رجوع لأوضاع AR" button uses — no teardown path
							// exists for this mode's physics world/vehicle/AI/
							// audio, so a full reload is the only "start clean"
							// option for EITHER choice here (see openExitConfirm's
							// own comment on this). 'restart' additionally stashes
							// hwArAutoRestart so init()/startARWithFloatingMenu
							// skip the AR mode picker and jump straight back into
							// the track instead of making the player re-pick it.
							try {

								sessionStorage.setItem( 'hwReturnToArMenu', JSON.stringify( { customText, vehicleKey, flagImage } ) );
								if ( action === 'restart' ) sessionStorage.setItem( 'hwArAutoRestart', 'track' );

							} catch ( e ) { /* ignore — falls back to the AR mode picker */ }

							raceCtx.resultsActive = false;
							raceCtx.leavingSession = true; // stop this frameUpdate from rendering again below
							arManager.session.end().finally( () => window.location.reload() );

						} );

					}

				}

			} catch ( e ) {

				console.error( '[main] floating-track frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── AR floating arena (Stage 4) ────────────────────────────
// An open rectangle for drifting — flat asphalt with the track's own
// red/white barrier around all 4 edges (buildBarrierSegment, same as the
// real track, world=null for visual-only/no physics), a curb-striped
// edge line, and corner dressing (floodlight poles, tire stacks, parked
// decoration cars) — but no walls/track loop of its own. Grabbable/
// movable/scalable, and a simple kinematic car, same mechanic as the
// floating track. halfX/halfZ are independent (was a
// single `half`, square-only) per feedback that the pad should be
// rectangular and bigger rather than a square.
function buildDriftPad( halfX, halfZ, models, scale = 1 ) {

	const pad = new THREE.Group();

	// Solid color sampled directly from the track's own shared palette
	// texture (models/Textures/colormap.png) — reverted from a custom
	// GLB asset (ground-tile.glb) back to a plain runtime-built plane,
	// since the GLB version was rendering as washed-out white instead
	// of the intended dark asphalt gray for reasons not fully
	// root-caused.
	const groundMesh = new THREE.Mesh(
		new THREE.PlaneGeometry( halfX * 2, halfZ * 2 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a40, roughness: 1, metalness: 0 } )
	);
	groundMesh.rotation.x = - Math.PI / 2;
	pad.add( groundMesh );

	// Same white-edge-line + red-rumble-strip curb as the web free-roam
	// arena, traced just inside the barrier loop below — keeps the pad's
	// edge styling consistent with the actual race track across web/AR.
	const edgeTexture = createTrackEdgeTexture( halfX * 2, halfZ * 2, halfX, halfZ );
	const edgeOverlay = new THREE.Mesh(
		new THREE.PlaneGeometry( halfX * 2, halfZ * 2 ),
		new THREE.MeshStandardMaterial( {
			map: edgeTexture, transparent: true, roughness: 0.9,
			metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
		} )
	);
	edgeOverlay.rotation.x = - Math.PI / 2;
	edgeOverlay.position.y = 0.001;
	pad.add( edgeOverlay );

	// heightScale left at its real default (1, same as the web free-roam
	// arena's own barrier at line ~2241) — a previous 4x here made the
	// barrier read as unrealistically tall next to the car (nearly 2.4m,
	// taller than the car itself) once CAR_VISUAL_BOOST was removed and
	// everything else went back to true 1:1 proportions. The barrier is a
	// low real-world jersey barrier (0.6m), meant to sit well below car
	// height, exactly like it does in web mode.
	buildBarrierLoop( pad, null, halfX, halfZ );

	// Floodlight poles + scattered tire stacks/parked decoration cars at
	// the 4 corners, same dressing as the web free-roam arena — added to
	// `pad` itself (not `scene`) so it grabs/moves/scales together with
	// the rest of the arena instead of staying behind at world scale.
	// `scale` (the caller's FIXED_SCALE) is forwarded to each pole so its
	// real SpotLight's distance/intensity scale down with the arena
	// instead of blowing out the tiny scaled-down scene.
	const poleInsetX = halfX * 0.82;
	const poleInsetZ = halfZ * 0.82;
	for ( const cx of [ -1, 1 ] ) {

		for ( const cz of [ -1, 1 ] ) {

			buildFloodlightPoleVisual( pad, cx * poleInsetX, cz * poleInsetZ, { x: 0, z: 0 }, 9, scale );

		}

	}

	// No `world` yet at this point (buildDriftPad runs during AR
	// placement/preview, before the arena is locked in and its physics
	// world is created) — stash the returned placement list on the group
	// itself so lockInAndStart() can build matching colliders later from
	// these exact captured positions/rotations instead of re-randomizing.
	pad.userData.decor = scatterCornerDecor( pad, models, halfX, halfZ, [ 'vehicle-truck-green', 'vehicle-truck-black', 'vehicle-truck-red' ] );

	return pad;

}

// Kinematic version of the web free-roam AI (random wander target,
// always full throttle, no easing off for turns — same idea as
// updateFreeRoamAI in the web build) for the floating arena. halfX/halfZ
// independent for the rectangular pad.
function createKinematicArenaAI( npcConfigs, models, parentGroup, halfX, halfZ ) {

	const spawnMarginX = halfX * 0.5;
	const spawnMarginZ = halfZ * 0.5;

	return npcConfigs.map( ( cfg, i ) => {

		const angle = ( i / npcConfigs.length ) * Math.PI * 2;
		const distFrac = 0.4 + Math.random() * 0.5;
		const x = Math.cos( angle ) * spawnMarginX * distFrac;
		const z = Math.sin( angle ) * spawnMarginZ * distFrac;
		const heading = Math.random() * Math.PI * 2;

		const model = ( models[ cfg.key ] || models[ 'vehicle-truck-yellow' ] ).clone();
		model.position.set( x, 0.5, z );
		model.rotation.y = heading;
		parentGroup.add( model );

		return { model, x, z, heading, speed: 0, target: { x, z }, retargetTimer: 0 };

	} );

}

function updateKinematicArenaAI( drivers, dt, racing, halfX, halfZ ) {

	const wanderRadiusX = halfX * 0.6;
	const wanderRadiusZ = halfZ * 0.6;
	const MAX_SPEED = 8, ACCEL = 10, TURN_RATE = 3.5;

	for ( const d of drivers ) {

		if ( ! racing ) continue;

		d.retargetTimer -= dt;
		const distToTarget = Math.hypot( d.target.x - d.x, d.target.z - d.z );

		if ( d.retargetTimer <= 0 || distToTarget < 3 ) {

			const a = Math.random() * Math.PI * 2;
			const r = Math.random();
			d.target = { x: Math.cos( a ) * wanderRadiusX * r, z: Math.sin( a ) * wanderRadiusZ * r };
			d.retargetTimer = 2 + Math.random() * 3;

		}

		const dx = d.target.x - d.x, dz = d.target.z - d.z;
		const dist = Math.hypot( dx, dz );

		if ( dist > 0.001 ) {

			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - d.heading;
			// Wrap to (-PI, PI]. NOTE: `((x+PI)%(2*PI))-PI` alone is
			// broken in JavaScript for x below -PI, because JS `%` keeps
			// the sign of the dividend (unlike e.g. Python's modulo) —
			// see the normalizeAngle() comment in AIController.js for the
			// full writeup and a real-physics repro. The extra
			// `+2*PI)%(2*PI)` forces a non-negative intermediate first.
			angleDiff = ( ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) ) - Math.PI;
			d.heading += THREE.MathUtils.clamp( angleDiff, - TURN_RATE * dt, TURN_RATE * dt );

		}

		d.speed += THREE.MathUtils.clamp( MAX_SPEED - d.speed, - ACCEL * dt, ACCEL * dt );
		d.x += Math.sin( d.heading ) * d.speed * dt;
		d.z += Math.cos( d.heading ) * d.speed * dt;

		const margin = 2;
		d.x = THREE.MathUtils.clamp( d.x, - halfX + margin, halfX - margin );
		d.z = THREE.MathUtils.clamp( d.z, - halfZ + margin, halfZ - margin );

		d.model.position.set( d.x, 0.5, d.z );
		d.model.rotation.y = d.heading;

	}

}

async function startARFloatingArena( { arManager, vehicleKey, customText, flagImage } ) {

	// Hit-test IS used (see the placing phase in frameUpdate below, via
	// arManager.updateExternalPlacement()) — just not ARManager's own
	// generic ring/arrow previewGroup, since the actual arena itself
	// (arenaGroup) is the preview here.
	arManager.previewGroup.visible = false;

	const placeholderCamera = new THREE.PerspectiveCamera();

	// Rectangular now (not square) and bigger overall, per feedback — X is
	// the long side. buildDriftPad/buildBarrierLoop/scatterCornerDecor/
	// the AI helpers below all take independent halfX/halfZ now instead of
	// one square `half`.
	// Bumped up from 16×10 per feedback that the arena felt small —
	// same ~1.3× per side (≈75% more floor area). Every wall/ground
	// collider and visual dressing below is already derived from these
	// two constants, so nothing else needs to change to match.
	// Bumped up again (~20% per side) per feedback that the arena still
	// felt small — every wall/ground collider, floodlight pole, barrier,
	// and corner decoration below is derived from these two constants
	// (buildDriftPad/scatterCornerDecor/createFreeRoamAI/lockInAndStart's
	// own colliders all take halfX/halfZ as parameters), so widening the
	// arena moves all of that dressing out along with it automatically —
	// nothing else needed to change to match.
	const PAD_HALF_X = 25;
	const PAD_HALF_Z = 16;

	// ✏️ EASY RETUNING KNOBS — see the identical comment in
	// startARFloatingTrack for what each one does (including TIME_SCALE,
	// used below via simDt, and why CAR_VISUAL_BOOST was removed in favor
	// of FIXED_SCALE being the one, consistent size knob) and why they're
	// all safe to change freely (purely cosmetic/pacing, no
	// physics-stability impact).
	// Bumped up again (0.03 → 0.039 → 0.05 → 0.08) to match the car/arena
	// AR tabletop size used by the reference "Drifting" project's own
	// drift-arena AR mode (its AR_CONTENT_SCALE constant) — since the
	// player's sphere radius here is a fixed real-world 0.5 (createSphereBody's
	// own default, unscaled — this mode's physics runs at full real scale,
	// see lockInAndStart() below), FIXED_SCALE alone already sets the
	// car's real-world tabletop diameter directly (0.5×2×FIXED_SCALE), so
	// matching that one number reproduces the same car size Drifting uses
	// (0.08m); the arena footprint scales the same way from PAD_HALF_X/Z,
	// which are unchanged.
	// Declared before buildDriftPad() (moved up from below) so it can be
	// forwarded into the pole lights' distance/intensity scaling.
	const FIXED_SCALE = 0.08;
	const arenaGroup = buildDriftPad( PAD_HALF_X, PAD_HALF_Z, models, FIXED_SCALE );

	// buildDriftPad() starts at identity transform (no internal offset
	// baked in, unlike buildTrack()'s trackGroup) — so unlike the
	// floating track, arenaGroup's own scale/position can be set
	// directly here without needing an extra wrapper group.
	// Reset to the game's base speed — see the identical note in
	// startARFloatingTrack.
	const TIME_SCALE = 1;
	// How long (seconds) a tire/drift mark stays on the ground before
	// fading — see the identical note in startARFloatingTrack.
	const DRIFT_MARK_LIFETIME = 4;
	// Extra headlight dimming, on top of FIXED_SCALE's own size-based
	// scaling — see the identical note in startARFloatingTrack.
	const AR_LIGHT_DAMPING = 0.35;
	arenaGroup.scale.setScalar( FIXED_SCALE );
	// Position/rotation are no longer a fixed guess — see the placing-
	// phase in frameUpdate below, which drives arenaGroup from the same
	// real-surface hit-test the room-drive AR mode uses (ARManager's
	// updateExternalPlacement()), so the arena lands on an actual
	// detected table/floor instead of floating at a hardcoded distance.
	// Hidden until the first surface hit lands.
	arenaGroup.visible = false;
	scene.add( arenaGroup );

	const light = new THREE.DirectionalLight( 0xffffff, 3 );
	light.position.set( 0.6, 1, 0.6 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	// Fill light + environment map — see the identical comments in
	// startARFloatingTrack for why each one is here (static position since
	// the arena is frozen in place once locked in).
	const fillLight = new THREE.DirectionalLight( 0xffffff, 0.22 );
	fillLight.position.set( -0.6, 0.5, -0.6 );
	scene.add( fillLight );
	ensureAREnvironment();

	// Same fix as startARFloatingTrack: dirLight (module-level, top of
	// file) is created once at page load and stays visible/full intensity
	// (3) forever unless something turns it off — nothing did for this
	// mode, so it was double-lighting the scene on top of this mode's own
	// purpose-built `light` above. Page reload on exit restores it for the
	// next mode.
	dirLight.visible = false;

	// ── Placement-phase preview: lightweight kinematic car + AI ──
	const previewContainer = new THREE.Group();
	const previewModel = ( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] ).clone();
	previewContainer.add( previewModel );
	previewContainer.position.set( 0, 0.5, 0 );
	arenaGroup.add( previewContainer );

	const previewAI = createKinematicArenaAI(
		NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ),
		models, arenaGroup, PAD_HALF_X, PAD_HALF_Z
	);

	let phase = 'placing'; // 'placing' -> 'racing'
	let raceCtx = null;

	function lockInAndStart() {

		try {

		arenaGroup.remove( previewContainer );
		previewAI.forEach( ( d ) => arenaGroup.remove( d.model ) );

		// Physics now runs at REAL scale, exactly like NORMAL mode's own
		// free-roam arena (real 9.81 gravity, real 0.5m car radius, real
		// PAD_HALF_X/PAD_HALF_Z-sized floor) — see the floating track's
		// identical fix/comment for why: shrinking physics itself down to
		// tabletop size
		// fights crashcat's own distance tolerances and Vehicle.js's
		// real-world-tuned driving-feel constants, which is what caused
		// the reported "car behaves oddly" symptom. `arenaGroup` itself
		// already carries the only thing actually needed for the AR
		// "tabletop" look — a pure VISUAL scale+placement transform (frozen
		// from this point on since frameUpdate stops calling
		// arManager.updateExternalPlacement() once phase leaves 'placing')
		// — so simulating underneath
		// it at full scale and parenting the car directly under
		// `arenaGroup` (see vehicleGroup below) lets three.js handle the
		// shrink automatically.
		const world = createPhysicsWorld();

		const groundHalfY = 0.01;
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ PAD_HALF_X, groundHalfY, PAD_HALF_Z ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ 0, - 0.125, 0 ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Four boundary walls matching the visual barrier loop's
		// rectangular footprint — same real-scale wall dimensions as
		// NORMAL mode's own free-roam arena walls (see startNormalMode's
		// freeRoam branch). North/south walls run along X at z=±PAD_HALF_Z;
		// east/west walls run along Z at x=±PAD_HALF_X.
		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallLocalY = - 0.125 + wallHalfHeight;
		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ PAD_HALF_X, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC, objectLayer: world._OL_STATIC,
				position: [ 0, wallLocalY, sign * PAD_HALF_Z ], friction: 0.2, restitution: 0.3,
			} );

			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, PAD_HALF_Z ] } ),
				motionType: MotionType.STATIC, objectLayer: world._OL_STATIC,
				position: [ sign * PAD_HALF_X, wallLocalY, 0 ], friction: 0.2, restitution: 0.3,
			} );

		}

		// Floodlight pole colliders — same real-scale local coordinate
		// space as the ground/wall colliders above (this physics `world`
		// runs at real scale, with arenaGroup's own scale+placement
		// transform doing the visual shrink/positioning — see the long
		// comment above this function). Same 0.82 inset formula as
		// buildDriftPad's own pole placement, since arenaGroup === the
		// `pad` group buildDriftPad built, so their local spaces match
		// exactly.
		const poleInsetX = PAD_HALF_X * 0.82;
		const poleInsetZ = PAD_HALF_Z * 0.82;
		const poleHeight = 9;
		for ( const cx of [ -1, 1 ] ) {

			for ( const cz of [ -1, 1 ] ) {

				rigidBody.create( world, {
					shape: cylinder.create( { halfHeight: poleHeight / 2, radius: 0.16 } ),
					motionType: MotionType.STATIC,
					objectLayer: world._OL_STATIC,
					position: [ cx * poleInsetX, poleHeight / 2, cz * poleInsetZ ],
					friction: 0.4,
					restitution: 0.15,
				} );

			}

		}

		// Tire stack / decoration car colliders, from the exact positions
		// scatterCornerDecor() actually placed them at (stashed on
		// arenaGroup.userData.decor by buildDriftPad) — not re-randomized,
		// so they line up with the visuals.
		if ( arenaGroup.userData.decor ) addDecorColliders( world, arenaGroup.userData.decor );

		// Real 0.5m car radius, spawned at the arena's own local center —
		// same defaults NORMAL mode's own free-roam arena uses.
		const sphereBody = createSphereBody( world, [ 0, 0.5, 0 ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spawnPos = [ 0, 0.5, 0 ];
		vehicle.spawnAngle = 0;
		vehicle.spherePos.set( 0, 0.5, 0 );
		vehicle.prevModelPos.set( 0, 0, 0 );
		vehicle.container.rotation.y = 0;

		const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
		// Parented under arenaGroup (not scene) — same idea as the
		// floating track's identical change: vehicle.container.position is
		// now real-scale "arena-local" coordinates, and arenaGroup's own
		// frozen scale+placement transform shrinks/places the car in sync
		// with the arena automatically, every frame — no manual coordinate
		// transform needed anywhere in this function.
		arenaGroup.add( vehicleGroup );
		addCustomTextDecals( vehicleGroup, customText );
		const vehicleLights = addVehicleLights( vehicle, true ); // true: this is the player's own car — real hazard lights
		const vehicleFlag = addVehicleFlag( vehicle, flagImage );
		// Same reasoning as the floating track's identical call — real-world
		// meters, arenaGroup's own shrink transform handles the rest.
		addARContactShadow( vehicleGroup );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup );
		audio.forceUnlock();

		// Smoke IS scaled for AR — see the identical note in
		// startARFloatingTrack (defaulting to scale=1 caused the reported
		// freeze/hang: real-meter-sized puffs, at default emission rate,
		// shared across the player AND all 3 AI every frame).
		// emitMultiplier halved again (0.15 -> 0.075, 0.06 -> 0.03) per
		// feedback that the arena's smoke was still causing stutter.
		// The puff-size ratio (SmokeTrails' own `scale` param, 2nd arg)
		// also cut 0.7 -> 0.3 per follow-up feedback: FIXED_SCALE itself
		// went up (0.05 -> 0.08, see its own comment) to match the
		// reference project's car size, and this ratio hadn't been
		// re-tuned to match — puffs were growing right along with it and
		// ended up visibly bigger than the car itself, reading as fog
		// covering it rather than a trailing smoke puff.
		const particles = new SmokeTrails( scene, FIXED_SCALE * 0.3, 0.075 );
		// Same AI-gets-its-own-lighter-pool split as startARFloatingTrack.
		const aiParticles = new SmokeTrails( scene, FIXED_SCALE * 0.3, 0.03 );
		// Drift marks fade out after DRIFT_MARK_LIFETIME seconds — see the
		// identical note in startARFloatingTrack.
		const driftMarks = new DriftMarks( scene, 'ar-floating-arena', FIXED_SCALE, DRIFT_MARK_LIFETIME );

		const _forward = new THREE.Vector3();
		const contactListener = {
			onContactAdded( bodyA, bodyB ) {

				if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;
				_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
				_forward.y = 0;
				_forward.normalize();
				const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
				audio.playImpact( impactVelocity );

			}
		};

		const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer: null, contactListener, vehicleFlag };

		// AI opponents — same wandering "تفحيط" free-roam AI as NORMAL
		// mode's own free-roam arena (createFreeRoamAI, reused unchanged),
		// parented under arenaGroup (passed in place of `scene`) so they
		// shrink/place in sync automatically. No visual boost now (see the
		// CAR_VISUAL_BOOST removal note above) — AI cars stay real/
		// unboosted size, same as the player and the arena's own
		// decoration cars, all governed by the one FIXED_SCALE transform.
		const aiDrivers = createFreeRoamAI(
			NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ),
			models, arenaGroup, world, PAD_HALF_X, PAD_HALF_Z
		);
		// AI flags always fly this fixed Saudi Arabia flag — never the
		// player's own flagImage — and don't change if the player changes
		// theirs. Flutter is driven every frame below (AI flags were
		// previously created but never animated — only the player's own
		// updateVehicleAndFx() call did that).
		const aiFlagUrl = createSaudiFlagDataUrl();
		const aiExtras = aiDrivers.map( ( d, i ) => {

			const lights = addVehicleLights( d.vehicle );
			// AI always shows hazard/emergency blinkers, but started on a
			// short delay instead of the instant lock-in creates them — per
			// feedback that the arena visibly hitches for a moment right at
			// lock-in, and hazards were suspected. This alone can't remove
			// the actual creation cost (the hazard lens/glow meshes for all
			// 3 AI cars are still built synchronously above, same as
			// everything else lock-in builds in one go), but it keeps the
			// blink state from also kicking in on that exact frame.
			setTimeout( () => { lights.hazardsOn = true; }, 400 );
			const flag = addVehicleFlag( d.vehicle, aiFlagUrl );
			const marks = new DriftMarks( scene, 'ar-floating-arena-ai-' + i, FIXED_SCALE, DRIFT_MARK_LIFETIME );
			return { lights, driftMarks: marks, flag };

		} );

		raceCtx = { world, vehicle, vehicleGroup, vehicleLights, audio, ctx, aiDrivers, aiExtras, aiParticles, arScale: FIXED_SCALE * AR_LIGHT_DAMPING };
		phase = 'racing';

		} catch ( e ) {

			console.error( '[main] floating-arena lock-in failed:', e );
			showErrorOverlay(
				( e && e.message ) ? e.message : String( e ),
				e && e.stack ? e.stack : '',
				() => window.location.reload(),
				'تعذّر تثبيت الحلبة — السيارة لم تُنشأ'
			);

		}

	}

	const controls = new Controls();

	return {

		// See the identical getter in startARFloatingTrack for why.
		get audio() { return raceCtx && raceCtx.audio; },

		frameUpdate( dt, timestamp, frame ) {

			try {

				if ( phase === 'placing' ) {

					// Same hit-test surface search + thumbstick nudge + trigger
					// confirm as the room-drive AR mode's own placement screen
					// (ARManager.updateExternalPlacement — see its comment, and
					// the identical setup in startARFloatingTrack) — the arena
					// stays hidden and glued to the camera's search until a real
					// surface (table, floor, …) is found, then follows that
					// surface (with thumbstick fine-adjustment) until the
					// trigger is pulled.
					const { hasHit, confirmEdge } = arManager.updateExternalPlacement( frame, dt );

					arenaGroup.visible = hasHit;

					if ( hasHit ) {

						arenaGroup.position.copy( arManager.arPosition );
						arenaGroup.quaternion.copy( arManager.arQuaternion );

					}

					updateKinematicArenaAI( previewAI, dt, false, PAD_HALF_X, PAD_HALF_Z );

					if ( confirmEdge ) {

						lockInAndStart();

					}

				} else if ( phase === 'racing' && raceCtx ) {

					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					};
					// simDt: physics/AI/particle time runs faster than real dt
					// (see TIME_SCALE note above) to counter the "miniature
					// effect" — a real-speed object viewed at a real, un-
					// shrunk distance always reads as slow motion no matter
					// its true speed, so we speed up sim time instead of
					// touching any physical constant. Input reading, button
					// edge-detection, and light-blink pacing all stay on the
					// real dt so controls and blink rate feel normal.
					const simDt = dt * TIME_SCALE;
					updateVehicleAndFx( simDt, input, raceCtx.ctx );
					updateVehicleLights( raceCtx.vehicleLights, dt, raceCtx.arScale, raceCtx.vehicle.linearSpeed < -0.01, FIXED_SCALE );

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( raceCtx.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( raceCtx.vehicleLights );
					setHighBeam( raceCtx.vehicleLights, arManager.getHighBeamHold(), raceCtx.arScale );
					raceCtx.audio.setHorn( arManager.getHornHold() );
					if ( arManager.getMusicToggle() ) bgMusic.muted = ! bgMusic.muted;

					// AI opponents: same wandering/drifting free-roam AI as
					// NORMAL mode, plus the same lights/flag/smoke/drift-
					// marks the player gets. Smoke reuses the player's own
					// shared SmokeTrails instance (see the identical note
					// in startARFloatingTrack).
					updateFreeRoamAIDrivers( raceCtx.aiDrivers, simDt, PAD_HALF_X, PAD_HALF_Z );
					raceCtx.aiDrivers.forEach( ( d, i ) => {

						const extra = raceCtx.aiExtras[ i ];
						raceCtx.aiParticles.update( simDt, d.vehicle );
						extra.driftMarks.update( simDt, d.vehicle );
						updateVehicleLights( extra.lights, dt, raceCtx.arScale, d.vehicle.linearSpeed < -0.01, FIXED_SCALE );
						if ( extra.flag ) extra.flag.updateFlutter( simDt, Math.abs( d.vehicle.linearSpeed / MAX_SPEED ) );

					} );

				}

			} catch ( e ) {

				console.error( '[main] floating-arena frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

async function startARMode( { arManager, mapParam, customText, vehicleKey, flagImage } ) {

	// See ensureAREnvironment()'s own comment (top of file) — same
	// reflections fix as the floating track/arena. No scale bump and no
	// extra fill light here: this mode already drives the shared, real-
	// scale dirLight/hemiLight every frame (see the dirLight.position.set
	// below) and the car's own size is directly player-controlled
	// (gameState.vehicleScale, thumbstick-resizable), not a fixed knob
	// like FIXED_SCALE in the tabletop modes — there's no "track/arena"
	// footprint here for a bigger car to stay proportional against.
	ensureAREnvironment();

	const world = createPhysicsWorld();
	arManager.setWorld( world );

	const placeholderCamera = new THREE.PerspectiveCamera(); // pose is overridden by WebXR while presenting

	let gameState = null; // populated once the user confirms spawn placement
	const controls = new Controls();

	arManager.onPlaced = ( spawn ) => {

		const sphereBody = createSphereBody( world, [ spawn.position.x, spawn.position.y, spawn.position.z ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.copy( spawn.position );
		vehicle.prevModelPos.set( spawn.position.x, 0, spawn.position.z );
		vehicle.container.rotation.y = spawn.angle;

		// The vehicle stays a direct child of `scene` (true WebXR world
		// space), matching how physics already works in NORMAL mode.
		const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
		scene.add( vehicleGroup );
		addCustomTextDecals( vehicleGroup, customText );
		const vehicleLights = addVehicleLights( vehicle, true ); // true: this is the player's own car — real hazard lights
		const vehicleFlag = addVehicleFlag( vehicle, flagImage );
		// Parented under vehicleGroup (not vehicleModel) — vehicleGroup's own
		// origin is always pinned at true ground level regardless of resize
		// (see the comment below), so the shadow doesn't need the same
		// min-Y correction the model itself does. Its scale is instead kept
		// in sync with gameState.vehicleScale manually, next to where the
		// model's own scale is set — see the thumbstick-resize handler below.
		const contactShadow = addARContactShadow( vehicleGroup );

		dirLight.target = vehicleGroup;

		// vehicleGroup's own origin isn't necessarily at wheel/ground level,
		// so scaling it directly made the car sink into or float above the
		// real floor as it resized. Instead scale only the inner model
		// child, and keep its lowest point pinned at the container's origin
		// (ground level) regardless of scale.
		const vehicleModel = vehicleGroup.children[ 0 ];
		const vehicleModelMinY = new THREE.Box3().setFromObject( vehicleModel ).min.y;

		// Smoke is authored at real-meter scale (BASE_SIZE=1 in Particles.js)
		// for NORMAL mode's much larger track. In AR the car is toy-sized,
		// so shrink smoke drastically or it renders as room-filling clouds
		// — a likely cause of the GPU overdraw/lag reported during drifting.
		const particles = new SmokeTrails( scene, 0.12 );
		// Fades after 9s instead of the default Infinity+localStorage
		// persistence — room-drive draws directly on the player's real
		// floor, so marks sticking around forever (and being saved/
		// restored across sessions) made less sense here than on a
		// purpose-built track.
		const driftMarks = new DriftMarks( scene, mapParam || 'ar-freeroam', 1, 9 );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup ); // XR camera rig instead of the NORMAL-mode chase Camera
		// AR mode has no DOM click/touchstart/keydown once inside the XR
		// session (input is XR controller triggers only), so Audio.js's
		// normal gesture-based unlock() would never fire and every sound
		// would stay silent forever. We already know a real user gesture
		// happened (the "Start AR" button press that got us into this
		// session), so it's safe to unlock immediately here instead.
		audio.forceUnlock();

		const _forward = new THREE.Vector3();

		const contactListener = {
			onContactAdded( bodyA, bodyB ) {

				if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

				_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
				_forward.y = 0;
				_forward.normalize();

				const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
				audio.playImpact( impactVelocity );

			}
		};

		// No lapTimer — free-roam has no track/laps.
		gameState = {
			vehicle, vehicleGroup, vehicleModel, vehicleModelMinY, vehicleScale: 1,
			particles, driftMarks, audio, vehicleLights, vehicleFlag, contactListener, contactShadow
		};

	};

	return {

		// See the identical getter in startARFloatingTrack for why.
		get audio() { return gameState && gameState.audio; },

		frameUpdate( dt, timestamp, frame ) {

			try {

				arManager.update( frame, dt );

				if ( gameState ) {

					// Controllers drive the car once the track is locked in;
					// keyboard/gamepad still work too (e.g. testing on desktop).
					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					};

					updateVehicleAndFx( dt, input, { world, ...gameState } );
					// Hazards get their own boosted scale here (not just
					// gameState.vehicleScale, which headlights/taillights use
					// as-is) — per feedback the room-mode hazard PointLights
					// were too faint to read as a real light source at the
					// car's normal 1:1 size. Bumped, not just made visible.
					const roomHazardScale = gameState.vehicleScale * 3.2;
					updateVehicleLights( gameState.vehicleLights, dt, gameState.vehicleScale, gameState.vehicle.linearSpeed < -0.01, roomHazardScale );

					const scaleInput = arManager.getScaleAdjustInput();
					if ( scaleInput !== 0 ) {

						gameState.vehicleScale = THREE.MathUtils.clamp(
							gameState.vehicleScale * ( 1 - scaleInput * 0.8 * dt ),
							0.03, 3.0
						);

						const s = gameState.vehicleScale;
						gameState.vehicleModel.scale.setScalar( s );
						// Keep the model's lowest point (wheels) pinned at
						// y=0 in container space — i.e. at ground level —
						// instead of scaling around the model's own origin,
						// which caused it to sink into or float above the
						// real floor as it resized.
						gameState.vehicleModel.position.y = gameState.vehicleModelMinY * ( 1 - s );
						if ( gameState.contactShadow ) gameState.contactShadow.scale.setScalar( s );

					}

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( gameState.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( gameState.vehicleLights );
					setHighBeam( gameState.vehicleLights, arManager.getHighBeamHold(), gameState.vehicleScale );
					gameState.audio.setHorn( arManager.getHornHold() );
					if ( arManager.getMusicToggle() ) bgMusic.muted = ! bgMusic.muted;

					if ( gameState.vehicleLights ) {

						arManager.setFloorGridVisible( gameState.vehicleLights.headlights[ 0 ].light.visible );

					}

					dirLight.position.set(
						gameState.vehicle.spherePos.x + 11.4,
						15,
						gameState.vehicle.spherePos.z - 5.3
					);

				} else {

					// Placement phase: still step physics so nothing is stale
					// once the vehicle spawns, but there is no vehicle yet.
					updateWorld( world, null, dt );

				}

			} catch ( e ) {

				console.error( '[main] AR frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── Shared animate loop ───────────────────────────────────

let activeMode = null;
const timer = new THREE.Timer();
let crashed = false;

function animate( timestamp, frame ) {

	if ( crashed ) return;

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	try {

		if ( activeMode ) activeMode.frameUpdate( dt, timestamp, frame );

	} catch ( e ) {

		crashed = true;
		console.error( '[animate] crashed:', e );
		showGenericErrorOverlay( e );

	}

}

renderer.setAnimationLoop( animate );

function showGenericErrorOverlay( error ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 70; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.95); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; overflow-y: auto;
	`;

	const title = document.createElement( 'div' );
	title.textContent = 'صار خطأ وتوقفت اللعبة';
	title.style.cssText = 'color:#fff; font-size:20px; font-weight:700;';

	const msg = document.createElement( 'div' );
	msg.textContent = String( error && error.message ? error.message : error );
	msg.style.cssText = 'color:#ffb4b4; font-size:14px; max-width:90%;';

	const stack = document.createElement( 'pre' );
	stack.textContent = error && error.stack ? error.stack : '';
	stack.style.cssText = `
		color:#9a94b0; font-size:11px; text-align:left; direction:ltr; max-width:90%; max-height:40vh;
		overflow:auto; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; white-space:pre-wrap;
	`;

	box.appendChild( title );
	box.appendChild( msg );
	box.appendChild( stack );
	document.body.appendChild( box );

}

function showErrorOverlay( message, stack, onRetry, title = 'تعذّر تشغيل وضع الواقع المعزز' ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 16px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.92); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
	`;

	const titleEl = document.createElement( 'div' );
	titleEl.textContent = title;
	titleEl.style.cssText = 'color:#fff; font-size:18px; font-weight:600;';

	const detail = document.createElement( 'div' );
	detail.textContent = message;
	detail.dir = 'ltr'; // raw browser/JS error text — keep readable, not mirrored
	detail.style.cssText = 'color:#ddd; font-size:14px; max-width:640px; white-space:pre-wrap;';

	const stackBox = document.createElement( 'div' );
	stackBox.textContent = stack ? stack.split( '\n' ).slice( 0, 6 ).join( '\n' ) : '';
	stackBox.dir = 'ltr';
	stackBox.style.cssText = 'color:#999; font-size:11px; max-width:640px; white-space:pre-wrap; text-align:left; font-family:monospace;';

	const retryBtn = document.createElement( 'button' );
	retryBtn.textContent = 'العودة للقائمة';
	retryBtn.style.cssText = `
		padding: 12px 28px; font-size: 15px; border-radius: 999px; border: none;
		cursor: pointer; background: #15A249; color: #fff;
	`;
	retryBtn.addEventListener( 'click', () => {

		box.remove();
		onRetry();

	} );

	box.appendChild( titleEl );
	box.appendChild( detail );
	box.appendChild( stackBox );
	box.appendChild( retryBtn );
	document.body.appendChild( box );

	console.error( title + ':', message, stack );

}

// Shown by init() right after a reload triggered by the in-AR "رجوع
// لأوضاع AR" button (see openExitConfirm's hwReturnToArMenu stash) —
// a minimal single-tap re-entry into AR instead of the full main menu.
// WebXR requires a fresh user gesture to (re-)request a session, so this
// can't be skipped even though the vehicle/text/flag choice already
// carried over from before the reload. Resolves { sessionPromise } once
// tapped (same shape createModeMenu()'s own AR button resolves with);
// rejects if the person instead taps through to the full main menu.
function showArResumeOverlay() {

	return new Promise( ( resolve, reject ) => {

		const box = document.createElement( 'div' );
		box.dir = 'rtl';
		box.style.cssText = `
			position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
			align-items: center; justify-content: center; gap: 18px; padding: 24px; text-align: center;
			background: rgba(20,22,26,0.95); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
		`;

		const title = document.createElement( 'div' );
		title.textContent = 'الرجوع للواقع المعزز';
		title.style.cssText = 'color:#fff; font-size:19px; font-weight:700;';

		const msg = document.createElement( 'div' );
		msg.textContent = 'اضغط للمتابعة واختيار المضمار أو الحلبة أو وضع الغرفة الحرة.';
		msg.style.cssText = 'color:#ccc; font-size:14px; max-width:420px;';

		const enterBtn = document.createElement( 'button' );
		enterBtn.textContent = 'الدخول للواقع المعزز';
		enterBtn.style.cssText = `
			padding: 14px 32px; font-size: 16px; border-radius: 999px; border: none;
			cursor: pointer; background: #15A249; color: #fff; font-weight:600;
		`;
		enterBtn.addEventListener( 'click', () => {

			// requestSession() started synchronously inside this click
			// handler, same reasoning as createModeMenu()'s own AR button —
			// some browsers only honor user-activation for a call made
			// directly in the event handler, not after any await hops.
			// 'dom-overlay' — see createModeMenu()'s own AR button for why.
			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor', 'hit-test' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection', 'dom-overlay' ],
				domOverlay: { root: document.body },
			} );
			startBgMusic();
			box.remove();
			resolve( { sessionPromise } );

		} );

		const homeBtn = document.createElement( 'button' );
		homeBtn.textContent = 'الرجوع للقائمة الرئيسية';
		homeBtn.style.cssText = `
			padding: 10px 24px; font-size: 13px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.3);
			cursor: pointer; background: transparent; color: #ccc;
		`;
		homeBtn.addEventListener( 'click', () => {

			box.remove();
			reject( new Error( 'user chose the main menu instead' ) );

		} );

		box.appendChild( title );
		box.appendChild( msg );
		box.appendChild( enterBtn );
		box.appendChild( homeBtn );
		document.body.appendChild( box );

	} );

}

async function init() {

	registerAll();
	await loadModels();

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
	let customCells = null;
	// Was only computed inside the `if (mapParam)` block below, leaving
	// it null for the default track (no ?map=) — which silently skipped
	// the grid-start/AI-opponent system, since that code all guards on
	// `spawn` being present. computeSpawnPosition() now defaults to the
	// built-in TRACK_CELLS on its own, so this works for both cases.
	let spawn = computeSpawnPosition( null );

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}

	// "إعادة السباق" (restart race) reloads the page for a guaranteed-clean
	// scene/physics-world reset — rebuilding everything in place without a
	// reload risks leaking the old track/car meshes and physics colliders
	// into the shared scene. What it should NOT do is send the player back
	// through the mode-selection menu first. onRestart below stashes the
	// race's exact settings here before reloading; if present, skip
	// straight to startNormalMode() with them instead of showing the menu.
	let restartData = null;
	try {
		const raw = sessionStorage.getItem( 'hwRestartRace' );
		if ( raw ) restartData = JSON.parse( raw );
	} catch ( e ) {
		restartData = null;
	}
	try {
		sessionStorage.removeItem( 'hwRestartRace' );
	} catch ( e ) { /* ignore */ }

	if ( restartData ) {

		try {

			activeMode = startNormalMode( { customCells, spawn, mapParam, ...restartData } );
			return;

		} catch ( e ) {

			activeMode = null; // fall through to the normal menu flow below

		}

	}

	// "رجوع لأوضاع AR" (the in-AR home button/exit-confirm) reloads the
	// page the same "start clean" way "إعادة السباق" above does, but
	// should land back on the AR track/arena/room picker specifically —
	// not the game's full main menu. openExitConfirm() (inside
	// startARWithFloatingMenu) stashes the vehicle/text/flag choice here
	// before reloading; if present, skip the main menu and show one small
	// "re-enter AR" button instead (a fresh user gesture is required to
	// re-request a WebXR session — browsers won't allow that
	// automatically right after a reload, so this can't jump straight
	// back in without SOME tap).
	let returnToArMenu = null;
	try {
		const rawAr = sessionStorage.getItem( 'hwReturnToArMenu' );
		if ( rawAr ) returnToArMenu = JSON.parse( rawAr );
	} catch ( e ) {
		returnToArMenu = null;
	}
	try {
		sessionStorage.removeItem( 'hwReturnToArMenu' );
	} catch ( e ) { /* ignore */ }

	const arAvailable = await ARManager.isSupported();

	if ( returnToArMenu && arAvailable ) {

		try {

			const { sessionPromise } = await showArResumeOverlay();
			activeMode = await startARWithFloatingMenu( {
				mapParam,
				customCells,
				customText: returnToArMenu.customText,
				vehicleKey: returnToArMenu.vehicleKey,
				flagImage: returnToArMenu.flagImage,
				sessionPromise,
			} );
			return;

		} catch ( e ) {

			activeMode = null; // fall through to the normal menu flow below

		}

	}

	// eslint-disable-next-line no-constant-condition
	while ( true ) {

		const { choice, customText, freeRoam, vehicleKey, flagImage, sessionPromise } = await createModeMenu( { arAvailable } );

		if ( choice === 'ar' ) {

			try {

				activeMode = await startARWithFloatingMenu( { mapParam, customCells, customText, vehicleKey, flagImage, sessionPromise } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve
					);

				} );
				continue; // back to the mode menu instead of a silent black screen

			}

		} else {

			try {

				activeMode = startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve
					);

				} );
				continue; // back to the mode menu instead of a silent black screen

			}

		}

	}

}

init();
