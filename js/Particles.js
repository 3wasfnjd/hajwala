import * as THREE from 'three';

const POOL_SIZE = 1280;
const PARTICLES_PER_EMIT = 3;
const EMIT_JITTER = 0.15;
const BASE_SIZE = 1;
const MAX_LIFE = 2.5;
const INV_MAX_LIFE = 1 / MAX_LIFE;

// Global emission-rate cut, applied on top of each mode's own
// emitMultiplier (which only shifts modes RELATIVE to each other — e.g.
// AI vs player, AR vs NORMAL). Per feedback that smoke was too heavy
// everywhere, this scales the spawn COUNT down uniformly across every
// mode (NORMAL, AR floating track, AR arena) without touching puff
// size/opacity/lifetime or any mode's existing ratio to the others.
const GLOBAL_EMIT_SCALE = 0.5;

const _blPos = new THREE.Vector3();
const _brPos = new THREE.Vector3();
const _containerWorldPos = new THREE.Vector3();

export class SmokeTrails {

	// emitMultiplier scales how many particles spawn per emission burst,
	// independent of visual `scale` — added so AR modes can cut the
	// emission RATE (the actual CPU/GPU cost driver: more live particles
	// = more per-frame buffer writes + draw cost) without changing how
	// tiny each individual puff renders. Defaults to 1 (no change) for
	// every existing caller, including NORMAL/web mode.
	constructor( scene, scale = 1, emitMultiplier = 1 ) {

		this.scale = scale;
		this.emitMultiplier = emitMultiplier;

		const positions = new Float32Array( POOL_SIZE * 3 );
		const opacities = new Float32Array( POOL_SIZE );
		const sizes = new Float32Array( POOL_SIZE );

		const geometry = new THREE.BufferGeometry();

		const posAttr = new THREE.BufferAttribute( positions, 3 );
		posAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'position', posAttr );

		const opacityAttr = new THREE.BufferAttribute( opacities, 1 );
		opacityAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'aOpacity', opacityAttr );

		const sizeAttr = new THREE.BufferAttribute( sizes, 1 );
		sizeAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'aSize', sizeAttr );

		const map = new THREE.TextureLoader().load( 'sprites/smoke.png' );

		const material = new THREE.PointsMaterial( {
			map,
			color: 0x5E5F6B,
			size: 1,
			sizeAttenuation: true,
			transparent: true,
			depthWrite: false,
		} );

		// PointsMaterial has no per-vertex size or alpha, so inject attributes
		// and fold them into gl_PointSize and diffuseColor.a.
		material.onBeforeCompile = ( shader ) => {

			shader.vertexShader = 'attribute float aSize;\nattribute float aOpacity;\nvarying float vOpacity;\n' + shader.vertexShader;
			shader.vertexShader = shader.vertexShader.replace(
				'void main() {',
				'void main() {\n\tvOpacity = aOpacity;'
			);
			shader.vertexShader = shader.vertexShader.replace(
				'gl_PointSize = size;',
				'gl_PointSize = size * aSize;'
			);

			shader.fragmentShader = 'varying float vOpacity;\n' + shader.fragmentShader;
			shader.fragmentShader = shader.fragmentShader.replace(
				'vec4 diffuseColor = vec4( diffuse, opacity );',
				'vec4 diffuseColor = vec4( diffuse, opacity * vOpacity );'
			);

		};

		const points = new THREE.Points( geometry, material );
		points.frustumCulled = false;
		scene.add( points );

		this.posAttr = posAttr;
		this.opacityAttr = opacityAttr;
		this.sizeAttr = sizeAttr;
		this.positions = positions;
		this.opacities = opacities;
		this.sizes = sizes;

		this.particles = [];

		for ( let i = 0; i < POOL_SIZE; i ++ ) {

			this.particles.push( {
				life: 0,
				velocity: new THREE.Vector3(),
				initialSize: 0,
			} );

		}

		this.emitIndex = 0;

	}

	update( dt, vehicle ) {

		const shouldEmit = vehicle.driftIntensity > 0.7;
		let aliveCount = 0;

		// How hard the drift is digging in, above the emission threshold —
		// used to scale emission rate/opacity/size so a real hard drift
		// looks noticeably heavier than one just barely qualifying.
		const heat = shouldEmit ? THREE.MathUtils.clamp( ( vehicle.driftIntensity - 0.7 ) / 1.3, 0, 1 ) : 0;
		this.heat = heat;

		if ( shouldEmit ) {

			// World-space Y, not local — container.position is only the
			// same thing as world position when container's parent is the
			// scene itself at identity transform (true in NORMAL mode).
			// The AR floating track/arena nest the vehicle under a scaled +
			// placed `arRoot` group instead, so local Y (real-scale meters)
			// and the wheels' getWorldPosition() below (already tiny/placed
			// AR-room coordinates) would otherwise be mixed from two
			// different spaces. getWorldPosition() resolves the current
			// matrix chain on demand, so this is correct and NOT one frame
			// stale, and is a no-op in NORMAL mode (identity parent chain).
			const roadY = vehicle.container.getWorldPosition( _containerWorldPos ).y + 0.05 * this.scale;
			const bl = vehicle.wheelBL ? vehicle.wheelBL.getWorldPosition( _blPos ) : null;
			const br = vehicle.wheelBR ? vehicle.wheelBR.getWorldPosition( _brPos ) : null;

			// up to 8/frame per wheel at max heat, before emitMultiplier/GLOBAL_EMIT_SCALE
			const perEmit = Math.max( 1, Math.round( ( PARTICLES_PER_EMIT + Math.round( heat * 5 ) ) * this.emitMultiplier * GLOBAL_EMIT_SCALE ) );

			for ( let i = 0; i < perEmit; i ++ ) {

				if ( bl ) this.emitAt( bl.x, roadY, bl.z );
				if ( br ) this.emitAt( br.x, roadY, br.z );

			}

		}

		const damping = 1 - dt;

		for ( let i = 0; i < POOL_SIZE; i ++ ) {

			const p = this.particles[ i ];
			if ( p.life <= 0 ) continue;

			p.life -= dt;

			if ( p.life <= 0 ) {

				this.opacities[ i ] = 0;
				aliveCount ++;
				continue;

			}

			const t = 1 - p.life * INV_MAX_LIFE;

			p.velocity.multiplyScalar( damping );

			const posIdx = i * 3;
			this.positions[ posIdx ] += p.velocity.x * dt;
			this.positions[ posIdx + 1 ] += p.velocity.y * dt;
			this.positions[ posIdx + 2 ] += p.velocity.z * dt;

			// Base opacity/size per particle also carries a bit of the
			// heat level it was born with (see emitAt), so a burst emitted
			// during a hard drift stays visibly thicker through its whole
			// life, not just at the moment of emission.
			this.opacities[ i ] = ( 1 - t ) * p.baseOpacity;
			this.sizes[ i ] = p.initialSize * ( 0.5 + t * 2.5 );

			aliveCount ++;

		}

		if ( shouldEmit || aliveCount > 0 ) {

			this.posAttr.needsUpdate = true;
			this.opacityAttr.needsUpdate = true;
			this.sizeAttr.needsUpdate = true;

		}

	}

	emitAt( x, y, z ) {

		const i = this.emitIndex;
		this.emitIndex = ( i + 1 ) % POOL_SIZE;

		const p = this.particles[ i ];
		const s = this.scale;
		const heat = this.heat || 0;

		const posIdx = i * 3;
		this.positions[ posIdx ] = x + ( Math.random() - 0.5 ) * EMIT_JITTER * s;
		this.positions[ posIdx + 1 ] = y + Math.random() * EMIT_JITTER * s;
		this.positions[ posIdx + 2 ] = z + ( Math.random() - 0.5 ) * EMIT_JITTER * s;

		// Heavier drifts get visibly bigger, more opaque smoke — real
		// burnout smoke billows much thicker than a light tire chirp.
		p.initialSize = BASE_SIZE * s * ( 0.5 + Math.random() * 0.5 ) * ( 1 + heat * 0.9 );
		p.baseOpacity = 0.25 + heat * 0.2;

		p.velocity.set(
			( Math.random() - 0.5 ) * 0.2 * s,
			( 0.5 + Math.random() * 0.5 ) * s,
			( Math.random() - 0.5 ) * 0.2 * s
		);

		p.life = MAX_LIFE;

	}

}
