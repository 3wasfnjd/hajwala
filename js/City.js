import * as THREE from 'three';
import { rigidBody, box, MotionType } from 'crashcat';

// Original, replaceable Hajwala district. No assets from Threejs-Punk are
// redistributed here: its public/ assets are excluded from its MIT license.
export const CITY_VERSION = '2026-09-city-1';
export const CITY_LIMIT = 98;

export function buildCityWorld( scene, world ) {

	const group = new THREE.Group();
	group.name = 'hajwala-city';
	const batches = new Map();
	const materials = new Map();
	const cameraObstacles = [];
	const bodies = [];
	const transform = new THREE.Object3D();
	const unitBox = new THREE.BoxGeometry( 1, 1, 1 );
	let seed = 260928;
	function random() {
		seed = ( Math.imul( seed, 1664525 ) + 1013904223 ) >>> 0;
		return seed / 4294967296;
	}
	function material( key, color, basic = false, options = {} ) {
		materials.set( key, basic
			? new THREE.MeshBasicMaterial( { color, ...options } )
			: new THREE.MeshStandardMaterial( { color, roughness: 0.76, metalness: 0.05, ...options } ) );
		batches.set( key, [] );
	}
	material( 'concrete', 0x253340 );
	material( 'walls0', 0x31404a );
	material( 'walls1', 0x4a424e );
	material( 'walls2', 0x354a47 );
	material( 'walls3', 0x4b4b52 );
	material( 'roof', 0x161f2a );
	material( 'sidewalk', 0x596573 );
	material( 'metal', 0x25303a, false, { metalness: 0.6, roughness: 0.35 } );
	material( 'glass', 0x152e3a, false, { metalness: 0.45, roughness: 0.24 } );
	material( 'windowAmber', 0xf7c577, true );
	material( 'windowTeal', 0x67d6c4, true );
	material( 'neon', 0x3fd5a4, true );
	material( 'stripe', 0xc6c3ad );
	material( 'lane', 0xd5ae55 );
	material( 'red', 0xbe554c );
	function block( key, x, y, z, width, height, depth, yaw = 0 ) {
		batches.get( key ).push( [ x, y, z, width, height, depth, yaw ] );
	}
	function collider( x, z, width, depth, height = 3, floor = 0, friction = 0 ) {
		const body = rigidBody.create( world, {
			shape: box.create( { halfExtents: [ width / 2, height / 2, depth / 2 ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ x, floor + height / 2, z ],
			friction, restitution: 0.1,
		} );
		bodies.push( body );
		return body;
	}
	function labelTexture( label, accent ) {
		const canvas = document.createElement( 'canvas' );
		canvas.width = 512;
		canvas.height = 128;
		const ctx = canvas.getContext( '2d' );
		ctx.fillStyle = '#101d28';
		ctx.fillRect( 0, 0, 512, 128 );
		ctx.strokeStyle = accent;
		ctx.lineWidth = 5;
		ctx.strokeRect( 5, 5, 502, 118 );
		ctx.fillStyle = accent;
		ctx.font = 'bold 45px Tahoma, Arial, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.direction = 'rtl';
		ctx.fillText( label, 256, 63, 470 );
		const texture = new THREE.CanvasTexture( canvas );
		texture.colorSpace = THREE.SRGBColorSpace;
		return texture;
	}
	const labels = [ 'كراج هجولة', 'قهوة الحي', 'عبودين قيمز', 'سوق المدينة' ];
	for ( let i = 0; i < labels.length; i ++ ) {
		material( 'sign' + i, 0xffffff, true, {
			map: labelTexture( labels[ i ], i % 2 ? '#ffd28c' : '#72e5c0' ),
		} );
	}

	// Flat driving surface; asphalt and collision share exactly the same Y.
	const asphaltCanvas = document.createElement( 'canvas' );
	asphaltCanvas.width = asphaltCanvas.height = 128;
	const asphaltCtx = asphaltCanvas.getContext( '2d' );
	const pixels = asphaltCtx.createImageData( 128, 128 );
	for ( let i = 0; i < pixels.data.length; i += 4 ) {
		const shade = 70 + Math.floor( random() * 18 );
		pixels.data.set( [ shade, shade + 5, shade + 10, 255 ], i );
	}
	asphaltCtx.putImageData( pixels, 0, 0 );
	const asphaltMap = new THREE.CanvasTexture( asphaltCanvas );
	asphaltMap.colorSpace = THREE.SRGBColorSpace;
	asphaltMap.wrapS = asphaltMap.wrapT = THREE.RepeatWrapping;
	asphaltMap.repeat.set( 70, 70 );
	const roadMaterial = new THREE.MeshStandardMaterial( {
		map: asphaltMap, color: 0x75858e, roughness: 0.54, metalness: 0.05,
	} );
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 260, 260 ), roadMaterial );
	ground.name = 'city-asphalt';
	ground.rotation.x = - Math.PI / 2;
	group.add( ground );
	collider( 0, 0, 260, 260, 0.4, -0.4, 5 );

	// Four compact blocks, a broad cross street, and a continuous outer loop.
	// Windows, trims, road marks and repeated facades are material-batched.
	let buildingCount = 0;
	function building( x, z, width, depth, height, style ) {
		const key = 'walls' + ( style % 4 );
		block( key, x, height / 2, z, width, height, depth );
		block( 'roof', x, height + 0.18, z, width + 0.35, 0.36, depth + 0.35 );
		block( 'concrete', x, 0.45, z, width + 0.2, 0.9, depth + 0.2 );
		collider( x, z, width + 0.2, depth + 0.2, height + 0.4 );
		cameraObstacles.push( new THREE.Box3(
			new THREE.Vector3( x - width / 2 - 0.35, 0, z - depth / 2 - 0.35 ),
			new THREE.Vector3( x + width / 2 + 0.35, height + 0.65, z + depth / 2 + 0.35 )
		) );
		for ( let floor = 3.4; floor < height - 0.8; floor += 2.25 ) {
			for ( const sign of [ -1, 1 ] ) {
				for ( let dx = -width / 2 + 1.5; dx < width / 2 - 1; dx += 2.25 ) {
					const lit = random() > 0.36;
					block( lit ? ( style % 2 ? 'windowAmber' : 'windowTeal' ) : 'glass',
						x + dx, floor, z + sign * ( depth / 2 + 0.025 ), 0.9, 1.25, 0.045 );
				}
				for ( let dz = -depth / 2 + 1.5; dz < depth / 2 - 1; dz += 2.25 ) {
					const lit = random() > 0.36;
					block( lit ? ( style % 2 ? 'windowAmber' : 'windowTeal' ) : 'glass',
						x + sign * ( width / 2 + 0.025 ), floor, z + dz, 0.045, 1.25, 0.9 );
				}
			}
		}
		// Ground-floor shopfronts face the nearest main north/south street.
		const facing = x < 0 ? 1 : -1;
		block( 'glass', x + facing * ( width / 2 + 0.04 ), 1.2, z, 0.06, 2.25, depth * 0.7 );
		block( 'neon', x + facing * ( width / 2 + 0.2 ), 2.6, z, 0.3, 0.1, depth * 0.78 );
		block( 'sign' + style % labels.length, x + facing * ( width / 2 + 0.12 ), 3.15, z,
			Math.min( 6.5, depth * 0.75 ), 1.05, 0.07, facing * Math.PI / 2 );
		block( 'metal', x + width * 0.22, height + 0.8, z - depth * 0.2, 2, 1.2, 1.7 );
		buildingCount ++;
	}
	for ( const sx of [ -1, 1 ] ) {
		for ( const sz of [ -1, 1 ] ) {
			block( 'sidewalk', sx * 39, 0.075, sz * 39, 46, 0.15, 46 );
			collider( sx * 39, sz * 39, 46, 46, 0.15, 0, 5 );
			for ( let i = 0; i < 2; i ++ ) {
				for ( let j = 0; j < 2; j ++ ) {
					const style = buildingCount % 4;
					building( sx * ( 25 + i * 27 ), sz * ( 25 + j * 27 ),
						13 + random() * 3, 13 + random() * 3, 9 + Math.floor( random() * 6 ) * 2.25, style );
				}
			}
		}
	}
	// Background facades remain behind the drivable loop.
	for ( const side of [ -1, 1 ] ) {
		for ( const position of [ -61, -31, 0, 31, 61 ] ) {
			building( side * 91, position, 9, 18, 12 + random() * 14, buildingCount );
			building( position, side * 91, 18, 9, 10 + random() * 13, buildingCount );
		}
	}

	// Markings are flat geometry, not additional images or lights.
	for ( const road of [ -72, 0, 72 ] ) {
		for ( let p = -81; p <= 81; p += 6 ) {
			if ( Math.abs( p ) < 18 || Math.abs( Math.abs( p ) - 72 ) < 10 ) continue;
			block( 'lane', road - 0.2, 0.012, p, 0.12, 0.018, 2.6 );
			block( 'lane', road + 0.2, 0.012, p, 0.12, 0.018, 2.6 );
			block( 'lane', p, 0.012, road - 0.2, 2.6, 0.018, 0.12 );
			block( 'lane', p, 0.012, road + 0.2, 2.6, 0.018, 0.12 );
		}
	}
	for ( const sign of [ -1, 1 ] ) {
		for ( let i = -5; i <= 5; i ++ ) {
			block( 'stripe', i * 1.05, 0.015, sign * 19, 0.55, 0.022, 2.4 );
			block( 'stripe', sign * 19, 0.015, i * 1.05, 2.4, 0.022, 0.55 );
		}
	}
	const ring = new THREE.Mesh(
		new THREE.RingGeometry( 10.9, 11.12, 64 ),
		new THREE.MeshBasicMaterial( { color: 0x82bbae, side: THREE.DoubleSide } )
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.022;
	group.add( ring );

	// Lamp posts use emissive heads; only four real lights light the plaza.
	for ( const side of [ -1, 1 ] ) {
		for ( const p of [ -59, -34, 34, 59 ] ) {
			for ( const axis of [ 0, 1 ] ) {
				const x = axis ? p : side * 14.8;
				const z = axis ? side * 14.8 : p;
				block( 'metal', x, 3, z, 0.14, 6, 0.14 );
				block( 'windowAmber', x, 6, z, 1.5, 0.1, 0.7 );
				collider( x, z, 0.2, 0.2, 6 );
			}
		}
	}
	for ( const sx of [ -1, 1 ] ) {
		for ( const sz of [ -1, 1 ] ) {
			const lamp = new THREE.PointLight( sx === sz ? 0x96e8d6 : 0xffd39b, 35, 36, 2 );
			lamp.position.set( sx * 13, 5.5, sz * 13 );
			group.add( lamp );
		}
	}
	// Visible, collidable perimeter keeps every car inside the playable map.
	for ( const side of [ -1, 1 ] ) {
		block( 'concrete', side * CITY_LIMIT, 0.75, 0, 0.8, 1.5, CITY_LIMIT * 2 );
		block( 'concrete', 0, 0.75, side * CITY_LIMIT, CITY_LIMIT * 2, 1.5, 0.8 );
		collider( side * CITY_LIMIT, 0, 0.8, CITY_LIMIT * 2, 4 );
		collider( 0, side * CITY_LIMIT, CITY_LIMIT * 2, 0.8, 4 );
	}
	for ( const [ key, transforms ] of batches ) {
		if ( ! transforms.length ) continue;
		const instances = new THREE.InstancedMesh( unitBox, materials.get( key ), transforms.length );
		instances.name = 'city-' + key;
		for ( let i = 0; i < transforms.length; i ++ ) {
			const [ x, y, z, w, h, d, yaw ] = transforms[ i ];
			transform.position.set( x, y, z );
			transform.rotation.set( 0, yaw, 0 );
			transform.scale.set( w, h, d );
			transform.updateMatrix();
			instances.setMatrixAt( i, transform.matrix );
		}
		instances.instanceMatrix.needsUpdate = true;
		instances.computeBoundingSphere();
		group.add( instances );
	}
	group.userData = {
		version: CITY_VERSION, buildingCount, colliderCount: bodies.length,
		batchCount: group.children.filter( object => object.isInstancedMesh ).length,
	};
	scene.add( group );
	const focus = new THREE.Vector3();
	const direction = new THREE.Vector3();
	const hit = new THREE.Vector3();
	const ray = new THREE.Ray();
	return {
		group,
		spawn: { position: [ 0, 0.5, -44 ], angle: 0 },
		resolveCamera( camera, position ) {
			focus.copy( position );
			focus.y += 0.6;
			direction.subVectors( camera.position, focus );
			const distance = direction.length();
			if ( distance < 0.001 ) return;
			direction.multiplyScalar( 1 / distance );
			ray.set( focus, direction );
			let allowed = distance;
			for ( const bounds of cameraObstacles ) {
				if ( ray.intersectBox( bounds, hit ) ) allowed = Math.min( allowed, focus.distanceTo( hit ) - 0.4 );
			}
			if ( allowed < distance ) {
				camera.position.copy( focus ).addScaledVector( direction, Math.max( 1.2, allowed ) );
				camera.lookAt( focus );
			}
		},
	};
}
