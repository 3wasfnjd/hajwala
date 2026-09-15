import * as THREE from 'three';
import { CELL_RAW, GRID_SCALE, TRACK_CELLS, TYPE_NAMES, computeSpawnPosition } from './Track.js';
import { TOTAL_RACE_LAPS as TOTAL_LAPS } from './AIController.js';

const FINISH = TYPE_NAMES[ 3 ];
const STORAGE_PREFIX = 'racing.bestLap.';
const _tmp = new THREE.Vector3();

function loadBest( key ) {

	try {

		const v = localStorage.getItem( key );
		const n = v !== null ? Number( v ) : NaN;
		return Number.isFinite( n ) ? n : null;

	} catch {

		return null;

	}

}

function saveBest( key, value ) {

	try {

		localStorage.setItem( key, String( value ) );

	} catch {}

}

function formatTime( t ) {

	if ( t === null || t === undefined ) return '0:00.00';

	const m = Math.floor( t / 60 );
	const s = t - m * 60;
	return `${ m }:${ s.toFixed( 2 ).padStart( 5, '0' ) }`;

}

export class LapTimer {

	constructor( cells, trackId ) {

		this.storageKey = STORAGE_PREFIX + ( trackId || 'default' );
		this.lap = 1;
		this.bestLap = loadBest( this.storageKey );
		this.lastLap = null;
		this.currentLapTime = 0;
		this.running = false;
		this.finished = false;
		this.totalTime = 0;
		this.onFinish = null; // set by the caller if it wants a callback instead of the built-in overlay

		this.lineCenter = new THREE.Vector3();
		this.lineForward = new THREE.Vector3( 0, 0, 1 );
		this.lineRight = new THREE.Vector3( 1, 0, 0 );

		this.prevForwardProj = null;

		this.cellSize = CELL_RAW * GRID_SCALE;
		this.requiredCells = new Set();
		this.visitedCells = new Set();

		const list = cells || TRACK_CELLS;
		this.enabled = list.some( ( c ) => c[ 2 ] === FINISH );

		if ( this.enabled ) {

			const spawn = computeSpawnPosition( list );
			this.lineCenter.set( spawn.position[ 0 ], 0, spawn.position[ 2 ] );
			this.lineForward.set( Math.sin( spawn.angle ), 0, Math.cos( spawn.angle ) );
			this.lineRight.set( this.lineForward.z, 0, - this.lineForward.x );

			for ( const c of list ) {

				if ( c[ 2 ] !== FINISH ) this.requiredCells.add( c[ 0 ] + ',' + c[ 1 ] );

			}

			this.buildUI();

		}

	}

	buildUI() {

		const style = document.createElement( 'style' );
		style.textContent = `
			#lap-timer {
				position: absolute;
				top: 12px;
				right: 12px;
				color: #fff;
				font: 600 13px 'Segoe UI', Tahoma, Arial, sans-serif;
				background: rgba(0,0,0,0.5);
				padding: 10px 14px;
				border-radius: 10px;
				line-height: 1.4;
				text-shadow: 0 1px 2px rgba(0,0,0,0.6);
				user-select: none;
				pointer-events: none;
				z-index: 10;
				min-width: 140px;
				backdrop-filter: blur(8px);
				-webkit-backdrop-filter: blur(8px);
			}
			#lap-timer .row { display: flex; justify-content: space-between; gap: 12px; }
			#lap-timer .label { opacity: 0.65; font-weight: 500; letter-spacing: 0.06em; }
			#lap-timer .current { font: 700 24px/1.1 'Segoe UI', Tahoma, Arial, sans-serif; font-variant-numeric: tabular-nums; margin: 4px 0 6px; }
			#lap-timer .stat { font-size: 12px; font-variant-numeric: tabular-nums; opacity: 0.9; }
			#race-finish-overlay {
				position: fixed; inset: 0; z-index: 55; display: flex; align-items: center; justify-content: center;
				background: rgba(5,5,10,0.75); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
			}
			#race-finish-overlay .rf-card {
				max-width: 380px; width: 90%; text-align: center; padding: 30px 26px; border-radius: 20px;
				background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
				border: 1px solid rgba(139,95,191,0.4); box-shadow: 0 0 50px rgba(91,60,140,0.25);
			}
			#race-finish-overlay .rf-title {
				font-size: 28px; font-weight: 800;
				background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
				-webkit-background-clip: text; background-clip: text; color: transparent;
				margin-bottom: 18px;
			}
			#race-finish-overlay .rf-row { display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.08); color: #cfc9e0; font-size: 14px; }
			#race-finish-overlay .rf-row:first-of-type { border-top: none; }
			#race-finish-overlay .rf-row b { color: #fff; font-variant-numeric: tabular-nums; }
			#race-finish-overlay button {
				margin-top: 20px; width: 100%; padding: 13px; border: none; border-radius: 999px;
				background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
			}
		`;
		document.head.appendChild( style );

		const placeholder = formatTime( null );
		const el = document.createElement( 'div' );
		el.id = 'lap-timer';
		el.dir = 'rtl';
		el.innerHTML =
			'<div class="row"><span class="label">اللفة</span><span class="lap">1/' + TOTAL_LAPS + '</span></div>' +
			`<div class="current">${ placeholder }</div>` +
			`<div class="row stat"><span class="label">الأخيرة</span><span class="last">${ placeholder }</span></div>` +
			`<div class="row stat"><span class="label">الأفضل</span><span class="best">${ formatTime( this.bestLap ) }</span></div>`;
		document.body.appendChild( el );

		this.lapEl = el.querySelector( '.lap' );
		this.currentEl = el.querySelector( '.current' );
		this.lastEl = el.querySelector( '.last' );
		this.bestEl = el.querySelector( '.best' );

	}

	update( dt, position, hasInput ) {

		if ( ! this.enabled || this.finished ) return;
		if ( ! this.running && ! hasInput ) return;
		this.running = true;

		this.currentLapTime += dt;
		this.totalTime += dt;
		this.currentEl.textContent = formatTime( this.currentLapTime );

		const gx = Math.floor( position.x / this.cellSize );
		const gz = Math.floor( position.z / this.cellSize );
		const key = gx + ',' + gz;
		if ( this.requiredCells.has( key ) ) this.visitedCells.add( key );

		_tmp.copy( position ).sub( this.lineCenter );
		const forwardProj = _tmp.dot( this.lineForward );
		const lateralProj = Math.abs( _tmp.dot( this.lineRight ) );

		if ( this.prevForwardProj !== null ) {

			const onLine = lateralProj <= this.cellSize * 0.5;
			const noTeleport = Math.abs( forwardProj - this.prevForwardProj ) < 5;
			const crossedForward = this.prevForwardProj < 0 && forwardProj >= 0;

			if ( onLine && noTeleport && crossedForward ) {

				if ( this.visitedCells.size === this.requiredCells.size ) this.completeLap();
				this.visitedCells.clear();

			}

		}

		this.prevForwardProj = forwardProj;

	}

	completeLap() {

		const isBest = this.bestLap === null || this.currentLapTime < this.bestLap;

		this.lastLap = this.currentLapTime;
		if ( isBest ) {

			this.bestLap = this.currentLapTime;
			saveBest( this.storageKey, this.bestLap );

		}

		if ( this.lap >= TOTAL_LAPS ) {

			this.finished = true;
			this.lapEl.textContent = TOTAL_LAPS + '/' + TOTAL_LAPS;
			this.lastEl.textContent = formatTime( this.lastLap );
			this.bestEl.textContent = formatTime( this.bestLap );
			if ( this.onFinish ) {

			this.onFinish();

		} else {

			this.showFinishOverlay();

		}
			return;

		}

		this.lap += 1;
		this.currentLapTime = 0;

		this.lapEl.textContent = this.lap + '/' + TOTAL_LAPS;
		this.lastEl.textContent = formatTime( this.lastLap );
		this.bestEl.textContent = formatTime( this.bestLap );

		const color = isBest ? '#5af168' : '#ff6e6e';
		this.currentEl.animate(
			[ { color }, { color }, { color: '#fff' } ],
			{ duration: 1200, easing: 'ease-out' }
		);

	}

	showFinishOverlay() {

		const overlay = document.createElement( 'div' );
		overlay.id = 'race-finish-overlay';
		overlay.dir = 'rtl';
		overlay.innerHTML = `
			<div class="rf-card">
				<div class="rf-title">🏁 انتهى السباق</div>
				<div class="rf-row"><span>الوقت الكلي</span><b>${ formatTime( this.totalTime ) }</b></div>
				<div class="rf-row"><span>أفضل لفة</span><b>${ formatTime( this.bestLap ) }</b></div>
				<button>حسنًا</button>
			</div>
		`;
		document.body.appendChild( overlay );
		overlay.querySelector( 'button' ).addEventListener( 'click', () => overlay.remove() );

	}

}
