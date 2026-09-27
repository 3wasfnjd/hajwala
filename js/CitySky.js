import * as THREE from 'three';

// Bake an original cloudy blue-hour panorama once. Sampling noise on a sphere
// keeps the horizon seamless; no sky geometry or cloud simulation runs per frame.
export function applyCitySky( renderer, scene ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 1024;
	canvas.height = 512;
	const context = canvas.getContext( '2d' );
	const pixels = context.createImageData( canvas.width, canvas.height );
	const mix = THREE.MathUtils.lerp;
	const smooth = THREE.MathUtils.smoothstep;
	function hash( x, y, z ) {
		let h = Math.imul( x, 374761393 ) ^ Math.imul( y, 668265263 ) ^ Math.imul( z, 2147483647 );
		h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
		return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967295;
	}
	function noise( x, y, z ) {
		const ix = Math.floor( x ), iy = Math.floor( y ), iz = Math.floor( z );
		const u = smooth( x - ix, 0, 1 ), v = smooth( y - iy, 0, 1 ), w = smooth( z - iz, 0, 1 );
		return mix(
			mix( mix( hash( ix, iy, iz ), hash( ix + 1, iy, iz ), u ),
				mix( hash( ix, iy + 1, iz ), hash( ix + 1, iy + 1, iz ), u ), v ),
			mix( mix( hash( ix, iy, iz + 1 ), hash( ix + 1, iy, iz + 1 ), u ),
				mix( hash( ix, iy + 1, iz + 1 ), hash( ix + 1, iy + 1, iz + 1 ), u ), v ), w );
	}
	function clouds( x, y, z ) {
		let sum = 0, weight = 0.5333;
		for ( let octave = 0; octave < 4; octave ++ ) {
			sum += noise( x, y, z ) * weight;
			x = x * 2.03 + 17; y = y * 2.03 + 9; z = z * 2.03 + 23;
			weight *= 0.5;
		}
		return sum;
	}
	const moon = new THREE.Vector3( 0.035, 0.18, 1 ).normalize();
	for ( let y = 0; y < canvas.height; y ++ ) {
		const latitude = Math.PI * ( y + 0.5 ) / canvas.height;
		const dy = Math.cos( latitude ), ring = Math.sin( latitude );
		const horizon = Math.exp( -Math.abs( dy ) * 4.5 );
		for ( let x = 0; x < canvas.width; x ++ ) {
			const longitude = 2 * Math.PI * ( ( x + 0.5 ) / canvas.width - 0.5 );
			const dx = ring * Math.cos( longitude ), dz = ring * Math.sin( longitude );
			const cloud = smooth( clouds( dx * 3.4 + 13, dy * 7.5 + 41, dz * 3.4 + 7 ), 0.32, 0.72 );
			const separation = 1 - ( dx * moon.x + dy * moon.y + dz * moon.z );
			const halo = Math.exp( -separation * 110 ) * ( 1 - cloud * 0.55 );
			const disk = ( 1 - smooth( separation, 0.00006, 0.00012 ) ) * ( 1 - cloud * 0.75 );
			const below = smooth( -dy, 0, 0.4 );
			const offset = ( y * canvas.width + x ) * 4;
			pixels.data[ offset ] = mix( mix( 25 + horizon * 57, 83 + horizon * 21, cloud ) + halo * 32 + disk * 150, 35, below );
			pixels.data[ offset + 1 ] = mix( mix( 42 + horizon * 55, 99 + horizon * 20, cloud ) + halo * 37 + disk * 150, 44, below );
			pixels.data[ offset + 2 ] = mix( mix( 73 + horizon * 49, 126 + horizon * 18, cloud ) + halo * 42 + disk * 145, 59, below );
			pixels.data[ offset + 3 ] = 255;
		}
	}
	context.putImageData( pixels, 0, 0 );
	const sky = new THREE.CanvasTexture( canvas );
	sky.name = 'city-cloudy-sky';
	sky.mapping = THREE.EquirectangularReflectionMapping;
	sky.colorSpace = THREE.SRGBColorSpace;
	scene.background = sky;
	// The same sky softly lights PBR surfaces and is reflected in the car.
	const generator = new THREE.PMREMGenerator( renderer );
	const environment = generator.fromEquirectangular( sky );
	scene.environment = environment.texture;
	scene.environmentIntensity = 1.15;
	generator.dispose();
	return { sky, environment };
}
