import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
	'.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };
const server = createServer( async ( req, res ) => {
	try {
		const pathname = decodeURIComponent( new URL( req.url, 'http://localhost' ).pathname );
		const file = resolve( root, '.' + ( pathname.endsWith( '/' ) ? pathname + 'index.html' : pathname ) );
		if ( ! file.startsWith( root + sep ) ) throw new Error( 'Invalid path' );
		const bytes = await readFile( file );
		res.writeHead( 200, { 'Content-Type': types[ extname( file ) ] || 'application/octet-stream' } );
		res.end( bytes );
	} catch { res.writeHead( 404 ); res.end( 'Not found' ); }
} );
await new Promise( done => server.listen( 4173, '127.0.0.1', done ) );
await mkdir( 'artifacts', { recursive: true } );
const browser = await chromium.launch( { headless: true, args: [
	'--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl',
] } );
const errors = [];
const reports = [];
try {
	const page = await browser.newPage( { viewport: { width: 960, height: 540 } } );
	page.on( 'pageerror', error => errors.push( String( error ) ) );
	page.on( 'console', message => {
		if ( /Shader Error|VALIDATE_STATUS|GL_INVALID/.test( message.text() ) ) errors.push( message.text() );
	} );
	let cityRequested = false;
	page.on( 'request', request => {
		if ( request.url().includes( '/js/City.js' ) ) cityRequested = true;
	} );
	await page.goto( 'http://127.0.0.1:4173/?debug=city', { waitUntil: 'domcontentloaded' } );
	await page.waitForSelector( '.hw-web-btn', { timeout: 120000 } );
	assert.equal( cityRequested, false, 'City module must not load before selection' );
	await page.locator( '.hw-web-btn' ).click();
	await page.locator( '.hw-web-city-btn' ).click();
	await page.waitForFunction( () => window.__hajwalaCity?.snapshot().weather?.weatherTime > 0.4, null, { timeout: 120000 } );
	const start = await page.evaluate( () => window.__hajwalaCity.snapshot() );
	assert.equal( start.buildingCount, 36 );
	assert.ok( start.colliderCount >= 40 );
	assert.ok( start.batchCount <= 24 );
	assert.ok( start.weather.rainCount >= 1200 && start.weather.splashCount >= 180 );
	assert.equal( start.weather.bloom, true );
	assert.ok( start.weather.reflectionFrames > 0, 'Wet road must render actual reflections' );
	assert.ok( start.position.every( Number.isFinite ) );
	assert.ok( start.position[ 1 ] > 0.35 && start.position[ 1 ] < 0.7, 'Car must rest on the road' );
	assert.equal( await page.locator( '#boot-error-overlay' ).count(), 0 );
	await page.screenshot( { path: 'artifacts/city-desktop.png' } );
	await page.keyboard.down( 'ArrowUp' );
	console.log( 'CITY_START ' + JSON.stringify( start ) );
	await page.waitForFunction( origin => {
		const state = window.__hajwalaCity.snapshot();
		return Math.hypot( state.position[ 0 ] - origin[ 0 ], state.position[ 2 ] - origin[ 2 ] ) > 2;
	}, start.position, { timeout: 90000 } );
	await page.keyboard.up( 'ArrowUp' );
	const moving = await page.evaluate( () => window.__hajwalaCity.snapshot() );
	console.log( 'CITY_MOVING ' + JSON.stringify( moving ) );
	assert.ok( Math.hypot( moving.position[ 0 ] - start.position[ 0 ], moving.position[ 2 ] - start.position[ 2 ] ) > 2,
		'Existing vehicle controls must move the car' );
	assert.ok( moving.position[ 1 ] > 0.25 && moving.position[ 1 ] < 1, 'Car must stay on ground while driving' );
	assert.ok( moving.weather.weatherTime > start.weather.weatherTime, 'Rain must animate while driving' );
	await page.screenshot( { path: 'artifacts/city-driving.png' } );
	await page.keyboard.down( 'ArrowUp' );
	await page.keyboard.down( 'ArrowLeft' );
	await page.waitForFunction( () => {
		const state = window.__hajwalaCity.snapshot();
		return Math.abs( Math.atan2( state.vehicleForward[ 0 ], state.vehicleForward[ 2 ] ) ) > 0.9;
	}, null, { timeout: 90000 } );
	await page.keyboard.up( 'ArrowLeft' );
	await page.keyboard.up( 'ArrowUp' );
	await page.waitForFunction( () => {
		const state = window.__hajwalaCity.snapshot();
		const dx = state.camera[ 0 ] - state.position[ 0 ], dz = state.camera[ 2 ] - state.position[ 2 ];
		const aligned = state.cameraForward[ 0 ] * state.vehicleForward[ 0 ] + state.cameraForward[ 2 ] * state.vehicleForward[ 2 ];
		return aligned > 0.98 && ( dx * state.vehicleForward[ 0 ] + dz * state.vehicleForward[ 2 ] ) / Math.hypot( dx, dz ) < -0.85;
	}, null, { timeout: 90000 } );
	const turning = await page.evaluate( () => window.__hajwalaCity.snapshot() );
	assert.ok( Math.abs( turning.cameraForward[ 0 ] ) > 0.5, 'Camera must orbit with the turning car' );
	await page.screenshot( { path: 'artifacts/city-rear-camera.png' } );
	reports.push( { device: 'desktop', start, moving, turning } );
	const preview = await page.screenshot( { type: 'jpeg', quality: 65 } );
	await page.close();

	// The deep link selects an existing Hajwala car and bypasses mode menus.
	const mobile = await browser.newPage( { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } );
	mobile.on( 'pageerror', error => errors.push( String( error ) ) );
	mobile.on( 'console', message => {
		if ( /Shader Error|VALIDATE_STATUS|GL_INVALID/.test( message.text() ) ) errors.push( message.text() );
	} );
	await mobile.goto( 'http://127.0.0.1:4173/?mode=city&vehicle=vehicle-camry&debug=city',
		{ waitUntil: 'domcontentloaded' } );
	await mobile.waitForFunction( () => window.__hajwalaCity?.snapshot().weather?.weatherTime > 0.4, null, { timeout: 120000 } );
	const mobileState = await mobile.evaluate( () => window.__hajwalaCity.snapshot() );
	assert.equal( mobileState.vehicleKey, 'vehicle-camry' );
	assert.ok( mobileState.weather.reflectionSize <= 256 && mobileState.weather.localLights <= 6 );
	assert.ok( mobileState.position.every( Number.isFinite ) );
	assert.equal( await mobile.locator( '#hajwalah-menu' ).count(), 0 );
	assert.equal( await mobile.locator( '#boot-error-overlay' ).count(), 0 );
	await mobile.screenshot( { path: 'artifacts/city-mobile.png' } );
	reports.push( { device: 'mobile-emulation', state: mobileState } );
	// Touch-up must point along the camera after turns, including the ±PI seam.
	const touchDirections = await mobile.evaluate( async () => {
		const { Camera } = await import( './js/Camera.js?v=city-chase-1' );
		const { Controls } = await import( './js/Controls.js' );
		const THREE = await import( 'three' );
		const cam = new Camera( { followVehicle: true, offset: new THREE.Vector3( 0, 3, -7.5 ) } );
		const target = new THREE.Vector3( 0, 0.5, 0 ), velocity = new THREE.Vector3();
		const orientation = new THREE.Quaternion(), up = new THREE.Vector3( 0, 1, 0 );
		return [ 0, Math.PI / 2, Math.PI - 0.01, -Math.PI + 0.01 ].map( heading => {
			orientation.setFromAxisAngle( up, heading );
			for ( let i = 0; i < 90; i ++ ) cam.update( 1 / 60, target, velocity, orientation );
			const input = Controls.prototype.update.call( { keys: {}, touchActive: true, touchDirX: 0, touchDirY: -1 }, cam.controlAngle );
			return input.x * cam.camForwardXZ.x + input.z * cam.camForwardXZ.z;
		} );
	} );
	assert.ok( touchDirections.every( alignment => alignment > 0.999 ), 'Touch steering must remain aligned with the rear camera' );

	// Exercise the actual physics engine against a city perimeter, not a mocked collider.
	const collision = await mobile.evaluate( async () => {
		const physics = await import( 'crashcat' );
		const { buildCityWorld } = await import( './js/City.js?v=chase-1' );
		const THREE = await import( 'three' );
		const { createSphereBody } = await import( './js/Physics.js' );
		const settings = physics.createWorldSettings();
		settings.gravity = [ 0, -9.81, 0 ];
		const movingLayer = physics.addBroadphaseLayer( settings );
		const staticLayer = physics.addBroadphaseLayer( settings );
		const movingObject = physics.addObjectLayer( settings, movingLayer );
		const staticObject = physics.addObjectLayer( settings, staticLayer );
		physics.enableCollision( settings, movingObject, staticObject );
		const world = physics.createWorld( settings );
		world._OL_MOVING = movingObject;
		world._OL_STATIC = staticObject;
		const city = buildCityWorld( new THREE.Scene(), world );
		// Start above an empty perimeter section so curb friction or a facade
		// cannot satisfy the wall assertion before the body reaches the wall.
		const body = createSphereBody( world, [ 77, 3, 96 ] );
		physics.rigidBody.setLinearVelocity( world, body, [ 0, 0, 22 ] );
		for ( let i = 0; i < 120; i ++ ) physics.updateWorld( world, {}, 1 / 120 );
		const boundary = Array.from( body.position );
		const camera = new THREE.PerspectiveCamera();
		camera.position.set( 25, 5, 36 );
		city.resolveCamera( camera, new THREE.Vector3( 25, 0.5, 12 ) );
		const cameraPosition = camera.position.toArray();
		camera.position.set( 25, 3.5, 22 );
		city.resolveCamera( camera, new THREE.Vector3( 25, 0.5, 16.3 ) );
		const closeCameraPosition = camera.position.toArray();
		// Approach above the sidewalk to isolate the building collision.
		const buildingBody = createSphereBody( world, [ 25, 3, 12 ] );
		physics.rigidBody.setLinearVelocity( world, buildingBody, [ 0, 0, 22 ] );
		for ( let i = 0; i < 120; i ++ ) physics.updateWorld( world, {}, 1 / 120 );
		return { boundary, building: Array.from( buildingBody.position ), camera: cameraPosition, closeCamera: closeCameraPosition };
	} );
	assert.ok( collision.boundary[ 2 ] < 97.15 && collision.boundary[ 2 ] > 94, 'Perimeter must stop the vehicle body' );
	assert.ok( collision.building[ 2 ] < 19, 'Building collider must stop the vehicle body' );
	assert.ok( collision.camera[ 2 ] < 20, 'Camera must stop before entering a building' );
	assert.ok( collision.closeCamera[ 2 ] < 16.65, 'Camera must also stay outside a wall when the car is close to it' );
	assert.ok( collision.boundary.every( Number.isFinite ) && collision.building.every( Number.isFinite ) );
	reports.push( { collision } );

	assert.deepEqual( errors, [], 'No uncaught browser errors' );
	console.log( 'CITY_CHECK_RESULT ' + JSON.stringify( reports ) );
	await writeFile( 'artifacts/city-check.json', JSON.stringify( { reports, errors }, null, 2 ) );
	// A small screenshot in the job output permits visual review without a local runtime.
	const encoded = preview.toString( 'base64' );
	for ( let i = 0; i < encoded.length; i += 8000 ) console.log( 'CITY_PREVIEW_CHUNK ' + String( i / 8000 ).padStart( 4, '0' ) + ' ' + encoded.slice( i, i + 8000 ) );
} catch ( error ) {
	console.error( 'CITY_BROWSER_ERRORS ' + JSON.stringify( errors ) );
	for ( const page of browser.contexts().flatMap( context => context.pages() ) ) {
		console.error( 'CITY_FAILURE_STATE ' + JSON.stringify( await page.evaluate( () => ({
			state: window.__hajwalaCity?.snapshot(), focus: document.activeElement?.tagName,
			width: innerWidth, height: innerHeight, hidden: document.hidden,
		}) ).catch( () => ({}) ) ) );
		const preview = await page.screenshot( { type: 'jpeg', quality: 55 } ).catch( () => null );
		if ( preview ) {
			const encoded = preview.toString( 'base64' );
			for ( let i = 0; i < encoded.length; i += 8000 ) console.log( 'CITY_FAILURE_PREVIEW ' + String( i / 8000 ).padStart( 4, '0' ) + ' ' + encoded.slice( i, i + 8000 ) );
		}
		console.error( 'CITY_FAILURE_PAGE ' + ( await page.locator( 'body' ).innerText().catch( () => '' ) ).slice( 0, 5000 ) );
	}
	throw error;
} finally {
	await browser.close();
	await new Promise( done => server.close( done ) );
}
