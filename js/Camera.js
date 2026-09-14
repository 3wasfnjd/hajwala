import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _lookPoint = new THREE.Vector3();
const _forward = new THREE.Vector3();

function lerpAngle( a, b, t ) {

	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < -Math.PI ) diff += Math.PI * 2;
	return a + diff * t;

}

export class Camera {

	// distanceScale: uniform multiplier on the base chase-cam offset — keeps
	// the same 45°/35° viewing angle, just further away, so more of a wide
	// open space (e.g. the free-roam arena) fits in frame. far: clip plane,
	// needs raising alongside distanceScale or a pulled-back camera would
	// itself sit past the default 60-unit far plane, or leave the arena's
	// far edge clipped/invisible instead of fading out through fog. near:
	// raise this together with far, not just far alone — a non-logarithmic
	// depth buffer spreads its precision across the near/far RANGE, so
	// pushing far way out while leaving near at the default 0.1 stretches
	// that ratio thin and starves precision at distance, which showed up as
	// flickering dark stripes/banding across the ground the moment the
	// camera pulled back far enough to see it (reported on video: z-fighting
	// between the ground plane and its skid-mark/edge decal overlays, whose
	// Y offsets from it are only ~0.001 apart). Every mode using the tight
	// default distance is unaffected either way (far=60/near=0.1 was already
	// a comfortable ratio for that range).
	// chaseHeading: opts into a rear third-person chase cam that stays
	// directly behind the car's own heading (rotates with it as it turns,
	// road stretching away toward the top of the screen) instead of the
	// fixed-world-angle isometric offset below — used by الطريق (highway)
	// mode, where a long straight road reads much better followed
	// head-on than viewed at a fixed diagonal angle. chaseDistance/
	// chaseHeight/chaseLookAhead tune how close and how "behind" it
	// sits. Every other mode never sets this, so its own update()
	// branch below is untouched.
	constructor( {
		distanceScale = 1, far = 60, near = 0.1,
		chaseHeading = false, chaseDistance = 6, chaseHeight = 1.8, chaseLookAhead = 4, chaseYawSmoothing = 3.5,
	} = {} ) {

		this.camera = new THREE.PerspectiveCamera( 40, window.innerWidth / window.innerHeight, near, far );

		this.chaseHeading = chaseHeading;
		this.chaseDistance = chaseDistance;
		this.chaseHeight = chaseHeight;
		this.chaseLookAhead = chaseLookAhead;
		// How quickly the camera's OWN facing catches up to the car's heading
		// — see update()'s chaseHeading branch for why this is smoothed
		// separately from the raw heading instead of following it 1:1.
		this.chaseYawSmoothing = chaseYawSmoothing;
		this._chaseYaw = null;

		// Matches Godot View: 45° azimuth, 35° elevation, distance 16 (×distanceScale)
		this.offset = new THREE.Vector3( 9.27, 9.18, 9.27 ).multiplyScalar( distanceScale );

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		// Camera-aligned ground basis (XZ plane), derived from offset.
		// camRightXZ: screen-right projected to ground.
		// camForwardXZ: screen-up (away from camera) projected to ground.
		this.camRightXZ = new THREE.Vector3( this.offset.z, 0, - this.offset.x ).normalize();
		this.camForwardXZ = new THREE.Vector3( - this.offset.x, 0, - this.offset.z ).normalize();

		this.leadFactor = 3.0;
		this.cameraSmoothing = 2.0;
		this.deadzoneRadius = 5.0;
		this.screenShiftUp = 1.0;

		this.smoothedDesired = new THREE.Vector3();
		this.initialized = false;

		const segments = 64;
		const points = [];
		for ( let i = 0; i <= segments; i ++ ) {

			const a = ( i / segments ) * Math.PI * 2;
			points.push( new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ) );

		}
		const dzGeom = new THREE.BufferGeometry().setFromPoints( points );
		this.debug = new THREE.Line( dzGeom, new THREE.LineBasicMaterial( { color: 0xff00ff, depthTest: false } ) );
		this.debug.visible = false;
		this.debug.renderOrder = 999;
		this.debug.quaternion.setFromRotationMatrix(
			new THREE.Matrix4().makeBasis( this.camRightXZ, new THREE.Vector3( 0, 1, 0 ), this.camForwardXZ )
		);

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	update( dt, target, velocity, heading ) {

		if ( this.chaseHeading && heading ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( heading );
			_forward.y = 0;
			if ( _forward.lengthSq() > 1e-6 ) _forward.normalize(); else _forward.set( 0, 0, 1 );

			// The car's raw heading whips around fast during a drift/tight
			// steering input — following it directly would swing the
			// camera itself around in lockstep, reading as "the camera
			// moves with the steering" instead of a settled rear-view
			// shot. Smoothing the YAW ANGLE here (not just the resulting
			// position below) makes the camera's own facing lag behind
			// and catch up gradually, like a real chase camera, instead
			// of snapping to match the car's instantaneous heading every
			// frame — exactly the "لا تربطها بحركة السيارة" ask.
			const rawYaw = Math.atan2( _forward.x, _forward.z );
			if ( this._chaseYaw === null ) this._chaseYaw = rawYaw;
			const yawAlpha = 1 - Math.exp( - dt * this.chaseYawSmoothing );
			this._chaseYaw = lerpAngle( this._chaseYaw, rawYaw, yawAlpha );
			// Public mirror of the smoothed yaw — main.js reads this to
			// keep the touch joystick's "up" direction matching whatever
			// this camera currently shows as "ahead" (see Controls.js's
			// own comment on its world-space joystick mapping, tuned for
			// a FIXED camera azimuth elsewhere — a rotating chase cam
			// needs that reference angle updated every frame instead).
			this.chaseYaw = this._chaseYaw;
			_forward.set( Math.sin( this._chaseYaw ), 0, Math.cos( this._chaseYaw ) );

			_desired.copy( target ).addScaledVector( _forward, - this.chaseDistance );
			_desired.y = target.y + this.chaseHeight;

			const chaseAlpha = this.initialized ? 1 - Math.exp( - dt * this.cameraSmoothing ) : 1;
			this.smoothedDesired.lerp( _desired, chaseAlpha );
			this.initialized = true;

			this.camera.position.copy( this.smoothedDesired );

			_lookPoint.copy( target ).addScaledVector( _forward, this.chaseLookAhead );
			_lookPoint.y = target.y + this.chaseHeight * 0.4;
			this.camera.lookAt( _lookPoint );

			this.debug.position.copy( target );
			this.debug.position.y += 0.05;
			this.debug.scale.set( this.deadzoneRadius, 1, this.deadzoneRadius );

			return;

		}

		const radius = this.deadzoneRadius;
		const radiusSq = radius * radius;

		// Lead = velocity projected onto camera-aligned ground basis, scaled, clamped to the deadzone disk.
		// Becomes the camera's offset from the car: car settles at the trailing edge of the circle.
		let leadX = velocity.dot( this.camRightXZ ) * this.leadFactor;
		let leadY = velocity.dot( this.camForwardXZ ) * this.leadFactor;
		const leadLenSq = leadX * leadX + leadY * leadY;
		if ( leadLenSq > radiusSq ) {

			const k = radius / Math.sqrt( leadLenSq );
			leadX *= k;
			leadY *= k;

		}

		_desired.copy( target )
			.addScaledVector( this.camRightXZ, leadX )
			.addScaledVector( this.camForwardXZ, leadY );

		const alpha = this.initialized ? 1 - Math.exp( - dt * this.cameraSmoothing ) : 1;
		this.smoothedDesired.lerp( _desired, alpha );
		this.initialized = true;

		// Hard-clamp: car must not escape the deadzone, even if the lerp lags at high speed.
		_delta.subVectors( target, this.smoothedDesired );
		const offsetX = _delta.dot( this.camRightXZ );
		const offsetY = _delta.dot( this.camForwardXZ );
		const offsetLenSq = offsetX * offsetX + offsetY * offsetY;
		if ( offsetLenSq > radiusSq ) {

			const offsetLen = Math.sqrt( offsetLenSq );
			const k = ( offsetLen - radius ) / offsetLen;
			this.smoothedDesired
				.addScaledVector( this.camRightXZ, offsetX * k )
				.addScaledVector( this.camForwardXZ, offsetY * k );

		}

		// Shift the entire view (camera + lookAt) so smoothedDesired sits higher on screen.
		_lookPoint.copy( this.smoothedDesired ).addScaledVector( this.camForwardXZ, - this.screenShiftUp );

		this.camera.position.copy( _lookPoint ).add( this.offset );
		this.camera.lookAt( _lookPoint );

		this.debug.position.copy( this.smoothedDesired );
		this.debug.position.y += 0.05;
		this.debug.scale.set( radius, 1, radius );

	}

}
