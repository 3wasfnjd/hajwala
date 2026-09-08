// Multiplayer.js — نظام غرفة لاعبين اثنين عبر WebRTC (PeerJS).
//
// لا يوجد backend خاص باللعبة: broker الـ PeerJS العام (0.peerjs.com)
// يُستخدم فقط لتبادل معلومات الاتصال الأولية (signaling)؛ بعد نجاح
// الاتصال تنتقل كل بيانات اللعبة مباشرة peer-to-peer عبر WebRTC
// DataChannel، بدون أي خادم وسيط يشوف حركة اللاعبين.
//
// كود الغرفة = 5 أحرف يولّدها المضيف (host) محليًا، ويُستخدم كمعرّف
// Peer id ثابت (بادئة ROOM_PREFIX لتفادي التصادم مع أي استخدام آخر
// لنفس شبكة PeerJS العامة). الضيف (guest) يتصل مباشرة بذلك المعرّف.
//
// هذا الملف لا يعرف شيئًا عن Vehicle/Track/الفيزياء — فقط طبقة نقل
// بيانات عامة (send/onData)، حتى يبقى بالإمكان إعادة استخدامه لاحقًا
// لأي نوع بيانات إضافي (دردشة، مزامنة إضاءات، إلخ) دون تعديله.

const ROOM_PREFIX = 'hajwalah-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون 0/O/1/I لتفادي الالتباس البصري
const CODE_LENGTH = 5;
const JOIN_TIMEOUT_MS = 15000;

function randomCode() {

	let code = '';
	for ( let i = 0; i < CODE_LENGTH; i ++ ) {

		code += CODE_ALPHABET[ Math.floor( Math.random() * CODE_ALPHABET.length ) ];

	}
	return code;

}

export class MultiplayerRoom {

	constructor() {

		this.peer = null;
		this.conn = null;
		this.isHost = false;
		this.code = null;

		// عيّنها المستدعي (main.js) بعد الإنشاء:
		this.onData = null;          // (data) => {}
		this.onConnected = null;     // () => {}  — القناة صارت جاهزة للإرسال/الاستقبال
		this.onDisconnected = null;  // (reason) => {}

		this._connectTimeout = null;

	}

	// المضيف: يولّد كود، يفتح peer بمعرّف ثابت مبني على الكود، وينتظر
	// اتصال الضيف. يرجّع Promise<code> بمجرد أن يصير الـ peer جاهز
	// (وليس بعد اتصال الضيف — ذاك يوصل لاحقًا عبر onConnected).
	createRoom() {

		return new Promise( ( resolve, reject ) => {

			if ( typeof Peer === 'undefined' ) {

				reject( new Error( 'PeerJS غير محمّل — تأكد من اتصال الإنترنت' ) );
				return;

			}

			const code = randomCode();
			const peer = new Peer( ROOM_PREFIX + code, { debug: 1 } );

			this.peer = peer;
			this.isHost = true;
			this.code = code;

			let settled = false;

			peer.on( 'open', () => {

				if ( settled ) return;
				settled = true;
				resolve( code );

			} );

			// أول اتصال وارد فقط يُقبل — غرفة لشخصين بالضبط. أي اتصال
			// إضافي بعد ذلك يُرفض فورًا (conn.close()) بدل تجاهله بصمت،
			// حتى لا يبقى الطرف الثالث معلّقًا يحاول.
			peer.on( 'connection', ( conn ) => {

				if ( this.conn ) { conn.close(); return; }
				this._bindConnection( conn );

			} );

			peer.on( 'error', ( err ) => {

				console.error( '[Multiplayer] host error:', err );
				if ( ! settled ) { settled = true; reject( err ); }
				else if ( this.onDisconnected ) this.onDisconnected( 'error' );

			} );

		} );

	}

	// الضيف: يفتح peer بمعرّف عشوائي (يولّده PeerJS نفسه)، ثم يتصل
	// بمعرّف المضيف الثابت المبني من الكود المُدخل. Promise تُحل بمجرد
	// فتح القناة فعليًا (نفس لحظة onConnected).
	joinRoom( code ) {

		return new Promise( ( resolve, reject ) => {

			if ( typeof Peer === 'undefined' ) {

				reject( new Error( 'PeerJS غير محمّل — تأكد من اتصال الإنترنت' ) );
				return;

			}

			const peer = new Peer( { debug: 1 } );

			this.peer = peer;
			this.isHost = false;
			this.code = String( code ).trim().toUpperCase();

			let settled = false;

			this._connectTimeout = setTimeout( () => {

				if ( settled ) return;
				settled = true;
				reject( new Error( 'timeout' ) );

			}, JOIN_TIMEOUT_MS );

			peer.on( 'open', () => {

				const conn = peer.connect( ROOM_PREFIX + this.code, { reliable: false } );
				this._bindConnection( conn );

				conn.on( 'open', () => {

					if ( settled ) return;
					settled = true;
					clearTimeout( this._connectTimeout );
					resolve();

				} );

			} );

			peer.on( 'error', ( err ) => {

				console.error( '[Multiplayer] guest error:', err );
				if ( ! settled ) {

					settled = true;
					clearTimeout( this._connectTimeout );
					reject( err );

				} else if ( this.onDisconnected ) {

					this.onDisconnected( 'error' );

				}

			} );

		} );

	}

	_bindConnection( conn ) {

		this.conn = conn;

		conn.on( 'data', ( data ) => { if ( this.onData ) this.onData( data ); } );

		conn.on( 'close', () => { if ( this.onDisconnected ) this.onDisconnected( 'closed' ); } );

		conn.on( 'error', ( err ) => {

			console.warn( '[Multiplayer] connection error:', err );
			if ( this.onDisconnected ) this.onDisconnected( 'error' );

		} );

		if ( conn.open ) {

			if ( this.onConnected ) this.onConnected();

		} else {

			conn.on( 'open', () => { if ( this.onConnected ) this.onConnected(); } );

		}

	}

	send( data ) {

		if ( this.conn && this.conn.open ) this.conn.send( data );

	}

	get isConnected() {

		return !! ( this.conn && this.conn.open );

	}

	close() {

		if ( this._connectTimeout ) clearTimeout( this._connectTimeout );
		if ( this.conn ) { try { this.conn.close(); } catch ( e ) {} }
		if ( this.peer ) { try { this.peer.destroy(); } catch ( e ) {} }
		this.conn = null;
		this.peer = null;

	}

}
