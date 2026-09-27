import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Original GPU weather; bounded particle counts, six local lights, one small
// reflection target. No downloaded textures and no per-drop CPU animation.
export function createCityWeather( group, emitters ) {

	const mobile = matchMedia( '(pointer: coarse)' ).matches;
	const rainCount = mobile ? 1200 : 1800;
	const center = new THREE.Vector3( 0, 0, -44 );
	const time = { value: 0 };
	const uniforms = { uTime: time, uCenter: { value: center } };
	let randomSeed = 91234;
	function random() {
		randomSeed = ( Math.imul( randomSeed, 1664525 ) + 1013904223 ) >>> 0;
		return randomSeed / 4294967296;
	}
	function particles( count, vertexShader, fragmentShader, name ) {
		const geometry = new THREE.InstancedBufferGeometry().copy( new THREE.PlaneGeometry( 1, 1 ) );
		const drops = new Float32Array( count * 4 );
		for ( let i = 0; i < drops.length; i ++ ) drops[ i ] = random();
		geometry.setAttribute( 'aDrop', new THREE.InstancedBufferAttribute( drops, 4 ) );
		geometry.instanceCount = count;
		const material = new THREE.ShaderMaterial( {
			uniforms, vertexShader, fragmentShader,
			transparent: true, depthWrite: false, side: THREE.DoubleSide,
			blending: THREE.AdditiveBlending,
		} );
		const mesh = new THREE.Mesh( geometry, material );
		mesh.name = name;
		mesh.frustumCulled = false;
		group.add( mesh );
		return mesh;
	}
	const rain = particles( rainCount, /* glsl */`
		attribute vec4 aDrop;
		uniform float uTime;
		uniform vec3 uCenter;
		varying vec2 vUv;
		varying float vAlpha;
		varying vec3 vTint;
		void main() {
			float height = mod(aDrop.y * 20.0 - uTime * (12.0 + aDrop.w * 9.0), 20.0);
			vec2 xz = mod(aDrop.xz * 54.0 - uCenter.xz + 27.0, 54.0) + uCenter.xz - 27.0;
			xz.x += height * 0.06;
			vec3 world = vec3(xz.x, height + 0.08, xz.y);
			vec4 view = viewMatrix * vec4(world, 1.0);
			float streak = 0.55 + aDrop.w * 0.65;
			view.xy += vec2(position.x * (0.022 + aDrop.w * 0.02) - position.y * streak * 0.10, position.y * streak);
			gl_Position = projectionMatrix * view;
			vUv = uv;
			vAlpha = (0.35 + aDrop.w * 0.4) * (1.0 - smoothstep(18.0, 32.0, distance(world, cameraPosition)));
			vAlpha *= smoothstep(0.15, 1.2, -view.z);
			vTint = mix(vec3(0.40, 0.78, 1.0), vec3(1.0, 0.55, 0.78), smoothstep(-12.0, 12.0, world.x));
		}
	`, /* glsl */`
		varying vec2 vUv;
		varying float vAlpha;
		varying vec3 vTint;
		void main() {
			float a = pow(1.0 - abs(vUv.x * 2.0 - 1.0), 1.5);
			a *= smoothstep(0.0, 0.2, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
			gl_FragColor = vec4(vTint * 1.7, a * vAlpha);
			#include <tonemapping_fragment>
			#include <colorspace_fragment>
		}
	`, 'city-rain' );
	const splashes = particles( mobile ? 180 : 280, /* glsl */`
		attribute vec4 aDrop;
		uniform float uTime;
		uniform vec3 uCenter;
		varying vec2 vUv;
		varying float vPhase;
		void main() {
			vec2 xz = mod(aDrop.xz * 40.0 - uCenter.xz + 20.0, 40.0) + uCenter.xz - 20.0;
			vPhase = fract(uTime * (0.8 + aDrop.w * 0.5) + aDrop.y);
			vec3 world = vec3(xz.x + position.x * 0.75, 0.035, xz.y + position.y * 0.75);
			gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
			vUv = uv;
		}
	`, /* glsl */`
		varying vec2 vUv;
		varying float vPhase;
		void main() {
			float ring = 1.0 - smoothstep(0.012, 0.035, abs(length(vUv - 0.5) - (0.04 + vPhase * 0.39)));
			gl_FragColor = vec4(0.55, 0.80, 1.0, ring * (1.0 - vPhase) * 0.38);
			#include <tonemapping_fragment>
			#include <colorspace_fragment>
		}
	`, 'city-rain-splashes' );

	const reflectionSize = mobile ? 256 : 384;
	const wetRoad = new Reflector( new THREE.PlaneGeometry( 260, 260 ), {
		textureWidth: reflectionSize, textureHeight: reflectionSize,
		multisample: 0, clipBias: 0.003,
		shader: {
			name: 'CityWetAsphalt',
			uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, uTime: { value: 0 } },
			vertexShader: /* glsl */`
				uniform mat4 textureMatrix;
				varying vec4 vReflection;
				varying vec3 vWorld;
				void main() {
					vReflection = textureMatrix * vec4(position, 1.0);
					vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tDiffuse;
				uniform float uTime;
				varying vec4 vReflection;
				varying vec3 vWorld;
				float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
				float noise(vec2 p) {
					vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
					return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
				}
				void main() {
					vec2 p = vWorld.xz;
					float puddle = smoothstep(0.24, 0.76, noise(p * 0.24) * 0.72 + noise(p * 0.85) * 0.28);
					vec2 ripple = vec2(sin(p.y * 23.0 + uTime * 3.0), cos(p.x * 19.0 - uTime * 2.0)) * 0.00065;
					vec2 uv = vReflection.xy / vReflection.w + ripple;
					float blur = mix(0.0035, 0.0008, puddle);
					vec3 reflected = texture2D(tDiffuse, uv).rgb * 0.4;
					reflected += texture2D(tDiffuse, uv + vec2(blur, 0)).rgb * 0.15;
					reflected += texture2D(tDiffuse, uv - vec2(blur, 0)).rgb * 0.15;
					reflected += texture2D(tDiffuse, uv + vec2(0, blur)).rgb * 0.15;
					reflected += texture2D(tDiffuse, uv - vec2(0, blur)).rgb * 0.15;
					float grazing = 1.0 - clamp(normalize(cameraPosition - vWorld).y, 0.0, 1.0);
					float alpha = (0.08 + puddle * 0.40) * (0.5 + grazing * 0.5);
					gl_FragColor = vec4(reflected * vec3(0.83, 0.93, 1.0), alpha);
					#include <tonemapping_fragment>
					#include <colorspace_fragment>
				}
			`,
		},
	} );
	wetRoad.name = 'city-wet-reflections';
	wetRoad.rotation.x = -Math.PI / 2;
	wetRoad.position.y = 0.006;
	wetRoad.material.transparent = true;
	wetRoad.material.depthWrite = false;
	wetRoad.material.uniforms.uTime = time;
	wetRoad.renderOrder = -2;
	group.add( wetRoad );
	const reflect = wetRoad.onBeforeRender;
	let reflectionAge = 1;
	let reflectionFrames = 0;
	wetRoad.onBeforeRender = function ( renderer, scene, camera ) {
		if ( reflectionAge < 1 / 24 ) return;
		reflectionAge = 0;
		// Render targets bypass the renderer's output processing. Bloom is
		// applied once to the final view; rain does not need a second pass.
		rain.visible = splashes.visible = false;
		try { reflect.call( this, renderer, scene, camera ); reflectionFrames ++; }
		finally { rain.visible = splashes.visible = true; }
	};

	const candidates = emitters.map( emitter => ( { ...emitter, distance: 0 } ) );
	const lights = Array.from( { length: 6 }, () => {
		const light = new THREE.PointLight( 0xffffff, 0, 30, 2 );
		group.add( light );
		return light;
	} );
	let lightAge = 1;
	const status = { rainCount, splashCount: splashes.geometry.instanceCount, reflectionSize, localLights: lights.length, weatherTime: 0, reflectionFrames: 0 };
	return {
		status,
		createRenderer( renderer, scene, camera, bloom ) {
			// The existing renderer uses an unsigned-byte output buffer, so
			// setEffects() alone cannot enable bloom. Use an HDR composer only
			// for this mode without changing the other modes' rendering path.
			const composer = new EffectComposer( renderer );
			composer.addPass( new RenderPass( scene, camera ) );
			composer.addPass( bloom );
			composer.addPass( new OutputPass() );
			const resize = () => {
				composer.setPixelRatio( Math.min( devicePixelRatio, mobile ? 1 : 1.25 ) );
				composer.setSize( innerWidth, innerHeight );
			};
			resize();
			window.addEventListener( 'resize', resize );
			status.bloom = true;
			// Count the whole scene, reflection and postprocessing, rather
			// than reporting only the final full-screen output triangle.
			renderer.info.autoReset = false;
			return dt => { renderer.info.reset(); composer.render( dt ); };
		},
		update( dt, position ) {
			center.copy( position );
			time.value += dt;
			reflectionAge += dt;
			lightAge += dt;
			if ( lightAge > 0.2 ) {
				lightAge = 0;
				for ( const candidate of candidates ) candidate.distance = ( candidate.x - position.x ) ** 2 + ( candidate.z - position.z ) ** 2;
				candidates.sort( ( a, b ) => a.distance - b.distance );
				for ( let i = 0; i < lights.length; i ++ ) {
					const source = candidates[ i ];
					if ( ! source ) continue;
					lights[ i ].position.set( source.x, source.y, source.z );
					lights[ i ].color.setHex( source.color );
					lights[ i ].intensity = source.intensity;
				}
			}
			status.weatherTime = time.value;
			status.reflectionFrames = reflectionFrames;
		},
	};
}
