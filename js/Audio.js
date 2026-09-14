import * as THREE from 'three';
import { createImpactBuffer } from './ImpactSound.js';
// RPM range is owned by the engine synth; import it so the 0..1 gear model
// here and the worklet's normalization can't drift apart.
import { RPM_IDLE, RPM_MAX } from './EngineWorklet.js';

function remap( value, inMin, inMax, outMin, outMax ) {

	return outMin + ( outMax - outMin ) * ( ( value - inMin ) / ( inMax - inMin ) );

}

const NUM_GEARS = 3;
const UPSHIFT_RPM = 0.92;
const DOWNSHIFT_RPM = 0.35;
const SHIFT_COOLDOWN = 0.35;
const SHIFT_CUT = 0.12; // throttle-cut at the start of a shift ("bra-ap braap")

// Collisions below this velocity use the dull-knock buffer set, above it the
// crunch set; velocity also drives per-hit volume and tone up to the ceiling.
const IMPACT_HARD_VELOCITY = 2.5;
const IMPACT_MAX_VELOCITY = 6;

// Camera follows at ~16 units. refDistance well below that puts a source
// ~7 dB down at nominal distance — the environment should sound "over there".
const REF_DISTANCE = 7;

// The engine is the player's own car: a reference distance below the camera
// distance keeps it fairly present, but not right at the ear.
const ENGINE_REF_DISTANCE = 11;

// Fixed high-end rolloff on the engine — a touch of air-absorption "distance"
// without the full perspective lowpass the environment sources get.
const ENGINE_CUTOFF = 5500;

// PannerNode only attenuates and pans, so a distance lowpass (exaggerated air
// absorption) is added separately: open when close, darkening with distance.
const _listenerPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();

function distanceCutoff( distance ) {

	return THREE.MathUtils.clamp(
		24000 * Math.pow( 6 / Math.max( distance, 6 ), 1.9 ),
		1200, 24000
	);

}

// Outdoor "air" impulse response: sparse early reflections + a short dark tail.
function createOutdoorIR( context ) {

	const sr = context.sampleRate;
	const length = Math.floor( 1.1 * sr );
	const buffer = context.createBuffer( 2, length, sr );

	for ( let ch = 0; ch < 2; ch ++ ) {

		const data = buffer.getChannelData( ch );

		// Early reflections: ground bounce + scattered distant objects
		for ( let r = 0; r < 8; r ++ ) {

			const t = 0.015 + Math.random() * 0.08;
			const idx = Math.floor( t * sr );
			data[ idx ] += ( Math.random() * 2 - 1 ) * ( 0.5 - r * 0.05 );

		}

		// Diffuse tail: lowpassed noise, exponential decay
		let lp = 0;
		const lpCoeff = 1 - Math.exp( - 2 * Math.PI * 2200 / sr );
		const start = Math.floor( 0.05 * sr );

		for ( let i = start; i < length; i ++ ) {

			const t = ( i - start ) / sr;
			lp += ( Math.random() * 2 - 1 - lp ) * lpCoeff;
			data[ i ] += lp * Math.exp( - t / 0.32 ) * 0.35;

		}

	}

	return buffer;

}

export class GameAudio {

	constructor() {

		this.listener = null;
		this.target = null;
		this.reverbSend = null;
		this.impactReverbSend = null;
		this.engineReverbSend = null;
		this.engineGain = null;
		this.engineRpmParam = null;
		this.engineLoadParam = null;
		this.skidSound = null;
		this.skidTone = null;
		this.reverseSound = null;
		this.launchSound = null;
		this.hornSound = null;
		this.hornOn = false;
		this.impactBuffers = [];
		this.impactPlayers = [];
		this.impactIndex = 0;
		this.distanceFilters = [];
		this.unlocked = false;

		this.rpm = 0;
		this.gear = 0;
		this.shiftCooldown = 0;

	}

	// `target` is the object the sounds live on (the vehicle container):
	// every source is a PositionalAudio child of it, panned and attenuated
	// relative to the camera-mounted listener.
	init( camera, target ) {

		this.listener = new THREE.AudioListener();
		camera.add( this.listener );

		this.target = target;

		// Shared outdoor reverb: sources send into one convolver. Impacts get
		// a hotter send — a crash reads as "in the world" mainly through its
		// environmental tail, which a brief transient otherwise barely excites.
		const ctx = this.listener.context;
		const convolver = ctx.createConvolver();
		convolver.buffer = createOutdoorIR( ctx );
		convolver.connect( this.listener.getInput() );

		this.reverbSend = ctx.createGain();
		this.reverbSend.gain.value = 0.15;
		this.reverbSend.connect( convolver );

		this.impactReverbSend = ctx.createGain();
		this.impactReverbSend.gain.value = 0.35;
		this.impactReverbSend.connect( convolver );

		this.engineReverbSend = ctx.createGain();
		this.engineReverbSend.gain.value = 0.11;
		this.engineReverbSend.connect( convolver );

		this.initEngine().catch( ( e ) => {

			console.warn( 'Engine synth unavailable:', e );

		} );

		// Skid loop: sample player with a tone filter that opens as the
		// drift intensifies
		const skid = this.createSampleSource( this.reverbSend );
		this.skidSound = skid.sound;
		this.skidTone = skid.tone;

		// Reverse loop: a separate, distinct tire sample — plays for as
		// long as the car is actually reversing, independent of the
		// cornering-drift skid sound above.
		const reverse = this.createSampleSource( this.reverbSend );
		this.reverseSound = reverse.sound;
		this.reverseTone = reverse.tone;

		// Launch chirp: a one-shot player, fired once per hard standing
		// start (see Vehicle.js's justLaunched). A simple non-looping
		// PositionalAudio, same reverb send as the skid/reverse loops.
		this.launchSound = this.makePositional( [ this.neutralLowpass() ] );
		this.launchSound.gain.connect( this.reverbSend );

		// Horn: real recorded sample (audio/horn.mp3) — same loader
		// pattern as skid/reverse/launch above.
		this.hornSound = this.makePositional( [ this.neutralLowpass() ] );
		this.hornSound.gain.connect( this.reverbSend );
		this.hornSound.setLoop( true );
		this.hornSound.setVolume( 0 );

		// Collision one-shots: two hardness sets of three seeded variations
		// each (soft knocks dully, hard crunches). Three shared players swap
		// in a random buffer per hit and add rate/tone variation on top.
		for ( let i = 0; i < 3; i ++ ) this.impactBuffers.push( createImpactBuffer( ctx, i + 1, 0.4 ) );
		for ( let i = 0; i < 3; i ++ ) this.impactBuffers.push( createImpactBuffer( ctx, i + 4, 1.0 ) );
		for ( let i = 0; i < 3; i ++ ) this.impactPlayers.push( this.createSampleSource( this.impactReverbSend ) );

		// Real recorded sample files — no synthesis, no conversion needed
		// (MP3 decodes fine in-browser).
		const loader = new THREE.AudioLoader();

		loader.load( 'audio/skid.mp3', ( buffer ) => {

			this.skidSound.setBuffer( buffer );
			this.skidSound.setLoop( true );
			this.skidSound.setVolume( 0 );

			if ( this.unlocked ) this.startSounds();

		} );

		loader.load( 'audio/reverse.mp3', ( buffer ) => {

			this.reverseSound.setBuffer( buffer );
			this.reverseSound.setLoop( true );
			this.reverseSound.setVolume( 0 );

			if ( this.unlocked ) this.startSounds();

		} );

		loader.load( 'audio/launch.mp3', ( buffer ) => {

			this.launchSound.setBuffer( buffer );
			this.launchSound.setLoop( false );
			this.launchSound.setVolume( 0.6 );

		} );

		loader.load( 'audio/horn.mp3', ( buffer ) => {

			this.hornSound.setBuffer( buffer );
			// If the player is already holding the horn button while this
			// finishes loading, start it immediately instead of waiting
			// for the next press.
			if ( this.hornOn && this.unlocked && ! this.hornSound.isPlaying ) {

				this.hornSound.play();
				this.hornSound.gain.gain.setTargetAtTime( 0.5, this.listener.context.currentTime, 0.01 );

			}

		} );

		const unlock = () => {

			if ( this.unlocked ) return;
			this.unlocked = true;

			if ( ctx.state === 'suspended' ) ctx.resume();

			this.startSounds();

			window.removeEventListener( 'keydown', unlock );
			window.removeEventListener( 'click', unlock );
			window.removeEventListener( 'touchstart', unlock );

		};

		this._unlock = unlock;

		window.addEventListener( 'keydown', unlock );
		window.addEventListener( 'click', unlock );
		window.addEventListener( 'touchstart', unlock );

		// Pause all audio when the tab is hidden; resume once it's visible
		// again (only if the user has already interacted to unlock playback).
		document.addEventListener( 'visibilitychange', () => {

			if ( document.hidden ) {

				if ( ctx.state === 'running' ) ctx.suspend();

			} else if ( this.unlocked && ctx.state === 'suspended' ) {

				ctx.resume();

			}

		} );

	}

	async initEngine() {

		const ctx = this.listener.context;

		await ctx.audioWorklet.addModule( new URL( './EngineWorklet.js', import.meta.url ) );

		const node = new AudioWorkletNode( ctx, 'engine-sound', {
			numberOfInputs: 0,
			outputChannelCount: [ 1 ],
		} );

		this.engineGain = ctx.createGain();
		this.engineGain.gain.value = 0;
		node.connect( this.engineGain );

		// Fairly present: a moderate reference distance, a fixed high-end
		// rolloff instead of the environment's distance-driven lowpass, and a
		// light reverb send. It pans with the car but sits a little back.
		const tone = this.neutralLowpass();
		tone.frequency.value = ENGINE_CUTOFF;

		const audio = new THREE.PositionalAudio( this.listener );
		audio.setRefDistance( ENGINE_REF_DISTANCE );
		audio.panner.panningModel = 'equalpower';
		audio.setFilter( tone );
		audio.setNodeSource( this.engineGain );
		this.target.add( audio );

		this.engineGain.connect( this.engineReverbSend );

		this.engineRpmParam = node.parameters.get( 'rpm' );
		this.engineLoadParam = node.parameters.get( 'load' );

	}

	// A transparent-until-driven lowpass. filters[0] on each source is the
	// perspective/distance filter; sample sources add a second for tone.
	neutralLowpass() {

		const filter = this.listener.context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.Q.value = 0.0001;
		filter.frequency.value = 24000;

		return filter;

	}

	// Positional source on the vehicle. filters[0] is registered as the
	// distance filter; it must be set before the source connects.
	makePositional( filters ) {

		const audio = new THREE.PositionalAudio( this.listener );
		audio.setRefDistance( REF_DISTANCE );
		audio.panner.panningModel = 'equalpower';
		audio.setFilters( filters );
		this.distanceFilters.push( filters[ 0 ] );
		this.target.add( audio );

		return audio;

	}

	// Sample player: distance filter + a tone filter for per-sound variation,
	// reverb tapped post-gain so the send tracks the sound's own volume.
	createSampleSource( reverbSend ) {

		const tone = this.neutralLowpass();
		const audio = this.makePositional( [ this.neutralLowpass(), tone ] );
		audio.gain.connect( reverbSend );

		return { sound: audio, tone };

	}

	startSounds() {

		if ( this.skidSound.buffer && ! this.skidSound.isPlaying ) this.skidSound.play();
		if ( this.reverseSound.buffer && ! this.reverseSound.isPlaying ) this.reverseSound.play();

	}

	// Public escape hatch for contexts where the normal click/touchstart/
	// keydown listeners above will never fire — namely an active WebXR AR
	// session, where all input comes through XR controller triggers, not
	// DOM events. Safe to call directly once we know a real user gesture
	// already happened (e.g. the "Start AR" button press that got us into
	// the session in the first place).
	forceUnlock() {

		if ( this._unlock ) this._unlock();

	}

	update( dt, speed, throttle, driftIntensity, isReversing = false ) {

		const absSpeed = THREE.MathUtils.clamp( Math.abs( speed ), 0, 1 );
		// Only forward throttle counts as engine load. Brake/reverse (throttle < 0)
		// should let RPM fall so downshifts can fire as the car decelerates.
		const load = THREE.MathUtils.clamp( Math.max( 0, throttle ), 0, 1 );

		const gearWindow = 1 / NUM_GEARS;
		const gearStart = this.gear * gearWindow;
		const inGear = THREE.MathUtils.clamp( ( absSpeed - gearStart ) / gearWindow, 0, 1 );

		let targetRpm = inGear * 0.85 + load * 0.2;
		targetRpm = THREE.MathUtils.clamp( targetRpm, 0, 1.05 );

		// Rise rate is deliberately gentle so each gear holds long enough to be
		// audible given the car's ~1.5s 0→max acceleration curve.
		const riseRate = 4;
		const fallRate = 4;
		const rate = targetRpm > this.rpm ? ( riseRate * ( 0.3 + load ) ) : fallRate;
		this.rpm = THREE.MathUtils.lerp( this.rpm, targetRpm, Math.min( 1, dt * rate ) );

		this.shiftCooldown = Math.max( 0, this.shiftCooldown - dt );

		if ( this.shiftCooldown === 0 ) {

			if ( this.rpm > UPSHIFT_RPM && this.gear < NUM_GEARS - 1 && load > 0.1 ) {

				this.gear ++;
				this.rpm = 0.45;
				this.shiftCooldown = SHIFT_COOLDOWN;

			} else if ( this.rpm < DOWNSHIFT_RPM && this.gear > 0 ) {

				this.gear --;
				this.rpm = 0.78;
				this.shiftCooldown = SHIFT_COOLDOWN;

			}

		}

		const now = this.listener.context.currentTime;

		// Perspective filtering: all sources sit on the car, so one distance
		// drives every filter
		this.listener.getWorldPosition( _listenerPos );
		this.target.getWorldPosition( _targetPos );
		const cutoff = distanceCutoff( _listenerPos.distanceTo( _targetPos ) );

		for ( const filter of this.distanceFilters ) {

			filter.frequency.setTargetAtTime( cutoff, now, 0.1 );

		}

		if ( this.engineRpmParam ) {

			// Cut throttle at the start of each shift so the synth sputters
			const shifting = this.shiftCooldown > SHIFT_COOLDOWN - SHIFT_CUT;

			this.engineRpmParam.value = RPM_IDLE + ( RPM_MAX - RPM_IDLE ) * this.rpm;
			this.engineLoadParam.value = shifting ? 0 : load;

			const targetVol = remap( absSpeed + load * 0.5, 0, 1.5, 0.04, 0.2 ); // lowered per feedback — engine was drowning out the radio
			this.engineGain.gain.setTargetAtTime( targetVol, now, 0.08 );

		}

		if ( this.skidSound.buffer ) {

			const shouldSkid = driftIntensity > 0.5;
			let skidVol = 0;

			if ( shouldSkid ) {

				skidVol = remap(
					THREE.MathUtils.clamp( driftIntensity, 0.5, 2.0 ),
					// Top end lowered again per feedback — a hard drift's
					// skid was "مزعج" (annoying/harsh) specifically at
					// high intensity; light/normal drifting near the 0.5
					// threshold was fine as-is, so only the ceiling moved
					// (0.45 → 0.28), not the floor.
					0.5, 2.0, 0.15, 0.28
				);

			}

			this.skidSound.gain.gain.setTargetAtTime( skidVol, now, 0.05 );

			const skidPitch = THREE.MathUtils.clamp( Math.abs( speed ), 1, 3 );
			const curPitch = this.skidSound.getPlaybackRate();
			this.skidSound.setPlaybackRate( THREE.MathUtils.lerp( curPitch, skidPitch, 0.1 ) );

			// Tone opens as the drift digs in: light slides stay dull,
			// hard drifts scream — ceiling pulled down (10000Hz → 7000Hz)
			// alongside the volume cut above, same "annoying specifically
			// at hard drift" complaint; light-slide tone (near the 0.5
			// threshold) is unchanged.
			const intensity01 = THREE.MathUtils.clamp(
				remap( driftIntensity, 0.5, 1.6, 0, 1 ), 0, 1
			);
			this.skidTone.frequency.setTargetAtTime( 2500 + intensity01 * 4500, now, 0.1 );

		}

		if ( this.reverseSound.buffer ) {

			// Independent of the skid/drift sound above — simply on
			// whenever the car is actually reversing, volume tracking
			// how fast it's backing up.
			const reverseVol = isReversing ? remap( absSpeed, 0, 0.6, 0.12, 0.3 ) : 0;
			this.reverseSound.gain.gain.setTargetAtTime( reverseVol, now, 0.08 );

			const reversePitch = THREE.MathUtils.clamp( 0.8 + absSpeed, 0.8, 1.6 );
			const curReversePitch = this.reverseSound.getPlaybackRate();
			this.reverseSound.setPlaybackRate( THREE.MathUtils.lerp( curReversePitch, reversePitch, 0.1 ) );

		}

	}

	// One-shot drag-style tire chirp — fired once per hard standing start
	// (see Vehicle.js's justLaunched edge-trigger). Restarts cleanly even
	// if a previous chirp hasn't finished (e.g. rapid stop-and-launches).
	playLaunch() {

		if ( ! this.unlocked || ! this.launchSound || ! this.launchSound.buffer ) return;

		if ( this.launchSound.isPlaying ) this.launchSound.stop();
		this.launchSound.play();

	}

	// Horn: press-and-hold, like a real horn. Starts the (already-loaded,
	// synthesized) loop on press and fades it in/out quickly to avoid a
	// click at the start/stop edges.
	setHorn( on ) {

		if ( ! this.hornSound || ! this.hornSound.buffer ) return;
		if ( on === this.hornOn ) return;
		this.hornOn = on;

		if ( ! this.unlocked ) return; // nothing audible would happen anyway

		const now = this.listener.context.currentTime;

		if ( on ) {

			if ( ! this.hornSound.isPlaying ) this.hornSound.play();
			this.hornSound.gain.gain.setTargetAtTime( 0.5, now, 0.01 );

		} else {

			this.hornSound.gain.gain.setTargetAtTime( 0, now, 0.03 );

		}

	}

	playImpact( impactVelocity ) {

		if ( ! this.unlocked ) return;

		// Round-robin a player; swap in a random buffer from the soft or hard
		// set so repeated hits of the same strength still differ.
		const { sound, tone } = this.impactPlayers[ this.impactIndex % this.impactPlayers.length ];
		this.impactIndex ++;

		const set = impactVelocity < IMPACT_HARD_VELOCITY ? 0 : 3;
		const buffer = this.impactBuffers[ set + ( Math.random() * 3 | 0 ) ];

		if ( sound.isPlaying ) sound.stop();
		sound.setBuffer( buffer );

		const volume = THREE.MathUtils.clamp(
			remap( impactVelocity, 0, IMPACT_MAX_VELOCITY, 0.01, 0.6 ), 0.01, 0.6 ); // lowered ceiling per feedback
		sound.setVolume( volume );

		// Variation on top of the seeded buffers: pitch jitter per hit,
		// tone tracks hit strength
		sound.setPlaybackRate( 0.9 + Math.random() * 0.2 );

		const brightness = THREE.MathUtils.clamp( impactVelocity / IMPACT_MAX_VELOCITY, 0, 1 );
		tone.frequency.value = ( 2500 + brightness * 9000 ) * ( 0.8 + Math.random() * 0.4 );

		sound.play();

		// PositionalAudio only tracks the panner while playing, so a one-shot
		// otherwise starts at a stale position. Snap it to the car now that
		// it's playing, so the crash attack is localised from the first sample.
		sound.updateMatrixWorld( true );

	}

}
