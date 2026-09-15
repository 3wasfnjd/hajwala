export class Controls {

	constructor() {

		this.keys = {};
		this.x = 0;
		this.z = 0;

		// Touch state
		this.touchActive = false;
		this.touchDirX = 0;
		this.touchDirY = 0;
		this.steerPointerId = null;
		this.steerStartX = 0;
		this.steerStartY = 0;

		window.addEventListener( 'keydown', ( e ) => this.keys[ e.code ] = true );
		window.addEventListener( 'keyup', ( e ) => this.keys[ e.code ] = false );

		this.setupTouchUI();

	}

	setupTouchUI() {

		if ( ! ( 'ontouchstart' in window ) ) return;

		// Fixed joystick pinned to the bottom-left corner (per feedback:
		// a permanent, always-visible control there, mirroring the
		// handbrake badge's own fixed spot at the bottom-right) — this
		// replaced an earlier "touch anywhere on screen" invisible zone
		// where the base/knob appeared wherever the finger first landed.
		// steer-zone is a fixed-size hit region at that same corner (a bit
		// bigger than the visible base, for a comfortable thumb target);
		// the base itself no longer moves — only the knob does, relative
		// to the base's own fixed center — and stays visible at all times
		// instead of only appearing while held.
		const css = document.createElement( 'style' );
		css.textContent = `
			.touch-controls { position: absolute; inset: 0; pointer-events: none; z-index: 10; }
			.steer-zone {
				position: fixed; left: 0; bottom: 0; width: 190px; height: 190px;
				pointer-events: auto; touch-action: none;
				display: flex; align-items: flex-end; justify-content: flex-start; padding: 22px;
			}
			.steer-base { position: relative; width: 130px; height: 130px; border-radius: 50%; background: rgba(255,255,255,0.12); border: 2px solid rgba(255,255,255,0.25); transition: background 0.15s, border-color 0.15s; }
			.steer-base.active { background: rgba(255,255,255,0.18); border-color: rgba(255,255,255,0.4); }
			.steer-knob { position: absolute; top: 50%; left: 50%; width: 58px; height: 58px; margin: -29px 0 0 -29px; border-radius: 50%; background: rgba(255,255,255,0.4); }
		`;
		document.head.appendChild( css );

		const container = document.createElement( 'div' );
		container.className = 'touch-controls';

		const steerZone = document.createElement( 'div' );
		steerZone.className = 'steer-zone';

		const base = document.createElement( 'div' );
		base.className = 'steer-base';
		const knob = document.createElement( 'div' );
		knob.className = 'steer-knob';
		base.appendChild( knob );
		steerZone.appendChild( base );

		container.appendChild( steerZone );
		document.body.appendChild( container );

		const steerRange = 40;

		steerZone.addEventListener( 'pointerdown', ( e ) => {

			// Any on-screen HUD chrome (the touch-button dock, the
			// speedometer's handbrake badge, the nav compass, ...) marks
			// itself with .game-hud so a tap on it can never also be read
			// as a steering touch here. This zone and that chrome are DOM
			// siblings, not ancestor/descendant, so a button's own
			// stopPropagation() only stops bubbling up shared ancestors —
			// it can't stop this zone's own independently-attached
			// listener from firing too if, on some browser/device,
			// hit-testing ever resolves a tap to both layers (reported:
			// pressing an on-screen button also steered/drove the car).
			// Checking the actual target here is a second, explicit guard
			// that doesn't depend on z-index/stacking alone.
			if ( e.target.closest( '.game-hud' ) ) return;
			if ( this.steerPointerId !== null ) return;
			steerZone.setPointerCapture( e.pointerId );
			this.steerPointerId = e.pointerId;
			// Anchored to the base's own fixed center (it no longer
			// follows the finger) — pointer capture still lets the finger
			// drag anywhere on screen afterward, same as before.
			const rect = base.getBoundingClientRect();
			this.steerStartX = rect.left + rect.width / 2;
			this.steerStartY = rect.top + rect.height / 2;
			this.touchActive = true;
			this.touchDirX = 0;
			this.touchDirY = 0;
			base.classList.add( 'active' );

		} );

		steerZone.addEventListener( 'pointermove', ( e ) => {

			if ( e.pointerId !== this.steerPointerId ) return;
			let dx = ( e.clientX - this.steerStartX ) / steerRange;
			let dy = ( e.clientY - this.steerStartY ) / steerRange;
			const mag = Math.sqrt( dx * dx + dy * dy );

			if ( mag > 1 ) {

				dx /= mag;
				dy /= mag;

			}

			this.touchDirX = dx;
			this.touchDirY = dy;
			knob.style.transform = `translate(${ this.touchDirX * 60 }px, ${ this.touchDirY * 60 }px)`;

		} );

		const endSteer = ( e ) => {

			if ( e.pointerId !== this.steerPointerId ) return;
			this.steerPointerId = null;
			this.touchActive = false;
			this.touchDirX = 0;
			this.touchDirY = 0;
			knob.style.transform = '';
			base.classList.remove( 'active' );

		};

		steerZone.addEventListener( 'pointerup', endSteer );
		steerZone.addEventListener( 'pointercancel', endSteer );

	}

	// worldAngle: the world-space azimuth that the touch joystick's "up"
	// should map to — see the joystick math below for how it's derived.
	// Defaults to this game's own fixed isometric camera's azimuth
	// (Math.PI/4, reproducing the original hardcoded SQRT1_2 constants
	// exactly), so every mode using the standard fixed-angle camera is
	// completely unaffected. الطريق (highway) mode's rear-following
	// camera instead passes its own current heading each frame, since a
	// fixed angle would only be correct for whichever way the car
	// happened to be pointed at spawn.
	update( worldAngle = Math.PI / 4 ) {

		let x = 0, z = 0;

		// Keyboard

		if ( this.keys[ 'KeyA' ] || this.keys[ 'ArrowLeft' ] ) x -= 1;
		if ( this.keys[ 'KeyD' ] || this.keys[ 'ArrowRight' ] ) x += 1;
		if ( this.keys[ 'KeyW' ] || this.keys[ 'ArrowUp' ] ) z += 1;
		if ( this.keys[ 'KeyS' ] || this.keys[ 'ArrowDown' ] ) z -= 1;

		// Gamepad

		const gamepads = navigator.getGamepads();

		for ( const gp of gamepads ) {

			if ( ! gp ) continue;

			const stickX = gp.axes[ 0 ];
			if ( Math.abs( stickX ) > 0.15 ) x = stickX;

			const rt = gp.buttons[ 7 ] ? gp.buttons[ 7 ].value : 0;
			const lt = gp.buttons[ 6 ] ? gp.buttons[ 6 ].value : 0;

			if ( rt > 0.1 || lt > 0.1 ) z = rt - lt;

			break;

		}

		// Touch — joystick mapped to world space, rotated by worldAngle
		// (defaults to reproducing the original fixed-45°-camera mapping
		// exactly: cos/sin of PI/4 are both SQRT1_2, matching the old
		// hardcoded constants bit for bit).
		if ( this.touchActive ) {

			const jx = this.touchDirX;
			const jy = this.touchDirY;
			const mag = Math.sqrt( jx * jx + jy * jy );

			if ( mag > 0.15 ) {

				const cosA = Math.cos( worldAngle ), sinA = Math.sin( worldAngle );
				x = ( jx * cosA + jy * sinA ) / mag;
				z = ( - jx * sinA + jy * cosA ) / mag;

			}

		}

		this.x = x;
		this.z = z;

		return { x, z, touchActive: this.touchActive, handbrake: !! this.keys[ 'KeyB' ] };

	}

}
