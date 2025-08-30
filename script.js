// Falling words with minimal physics using Matter.js
// Simplified: just fall, stack, and freeze after settling. No friction/density/drag tuning.

(() => {
	const { Engine, Runner, Bodies, Composite, Body, Events, Query, Sleeping } = Matter;

	// ---- CONFIG: tweak everything here ----
	const CONFIG = {
		// Text content and spawn
		words: [
	        'baby','love','mine','darling'
		],
		initialBurst: 1,     // how many words to drop at start
		spawnEveryMs: 150 ,   // interval between drops
		spawnLimit: 130,     // total number of words to spawn (includes initialBurst). Set to null for unlimited
		maxWords: 130,       // optional cap kept for safety
		spawnHorizontalSpread: 1, // % of screen width used for random x offset around center (1.0 = full width)
		spawnHeightMin: 200,  // min pixels above top
		spawnHeightRand: 300,// extra random pixels above top

		// Sizes & visuals
		minWordWidth: 0,
		minWordHeight: 0,
		cornerRadius: 0,
		// Typography
		fontSizePx: 50,
		// Selection/animation timings
		redTransitionMs: 1000,

		// Post-blast message timings and content
		postMessageDelayMs: 5000,   // delay after blast before showing the first line
		postMessageFadeMs: 4500,     // fade-in duration for each line
		postMessageStaggerMs: 3000,  // wait between lines
		postMessageLineGapPx: 50,   // vertical gap between lines
		postMessageFontSizePx: 50, // override font size for the post-blast lines (defaults to word size)
		postMessages: [
			"No words are enough for you ❤️",
			"You're my favorite person in this universe",
			"Happy Birthday, my love 💫"
		],

		// Emoji sprinkle settings (spawned behind final message)
		emojiSprinkle: {
			emojis: ["❤️"],
			fontSize: 20,              // px
			spawnInterval: 0,        // ms between spawns
			spawnLimit: 500,            // max emojis
			distanceRange: [30, 40],   // min/max spacing between emojis in px
			offsetRange: [-60, 60],     // allowed offset around message box
			noSpawnPadPx: 10,        // explicit padding around message (overrides offsetRange magnitude if set)
			spawnSlowdownMsPerSpawn: .1,// how much to increase interval after each spawn (0 = constant rate)
			gridCellScale: 2,          // grid cell = fontSize * scale (default 2x font)
		},

		///////// Mobile-specific overrides (applied when on a phone-sized viewport)
		mobileBreakpointPx: 520,
		mobileOverrides: {

            spawnEveryMs: 150,
			// Typography
			fontSizePx: 30,
			postMessageFontSizePx: 20,
			postMessageLineGapPx: 36,
			// Post-blast timings
			postMessageDelayMs: 5000,
			postMessageFadeMs: 4500,
			postMessageStaggerMs: 2200,
			// Spawn caps
			spawnLimit: 120,
			maxWords: 120,
			// Blast realism
			blastStrength: 15,
			blastSpin: 1.2,
            blastWindMs: 300,
			shakeMs: 700,
			shakeMag: 26,
			particleCount: 40,
			particleMaxLen: 360,
		},

		// Sounds
		soundPopSrc: 'sounds/pop.mp3',
		soundPianoSrc: 'sounds/piano.wav',
		soundPopVolume: 1,
		soundPianoVolume: 0.8,
		soundPianoLoop: true,
		soundPianoDelayMs: 600, // when to start piano after blast
		soundPopPreMs: 500,     // play pop this many ms before the blast

		// Blast realism settings
		blastStrength: 40,      // base outward speed imparted (px/tick)
		blastSpin: 1.5,         // max angular velocity kick
		blastWindMs: 600,       // duration of outward wind that follows the initial impulse
		blastWindForce: 0.0009, // base outward force per tick during wind
		shakeMs: 700,           // camera shake duration
		shakeMag: 40,           // camera shake magnitude in px
		particleCount: 50,      // visual particles
		particleMaxLen: 500,    // max particle travel distance

		// Physics
		gravity: .5,

		// Rotation
		rotationMinDeg: -60,
		rotationMaxDeg: 60,
	};

	// Expose quick CONFIG tuning from DevTools
	window.FallingWords = { CONFIG };

	const scene = document.getElementById('scene');
	const overlay = document.getElementById('overlay');
	const startBtn = document.getElementById('startBtn');
	const W = () => scene.clientWidth;
	const H = () => scene.clientHeight;

	// Apply phone overrides early so everything uses the right CONFIG
	(function applyMobileOverrides() {
		try {
			const bp = CONFIG.mobileBreakpointPx ?? 520;
			const smallViewport = window.matchMedia && window.matchMedia(`(max-width: ${bp}px)`).matches;
			const touchSmall = (navigator.maxTouchPoints || 0) > 0 && Math.min(window.innerWidth, window.innerHeight) <= bp;
			if ((smallViewport || touchSmall) && CONFIG.mobileOverrides) {
				Object.assign(CONFIG, CONFIG.mobileOverrides);
			}
		} catch {}
	})();

	// Audio handles
	let sndPop = null;
	let sndPiano = null;
	let popPlayed = false;
	function initAudio() {
		try {
			sndPop = new Audio(CONFIG.soundPopSrc);
			sndPop.preload = 'auto';
			sndPop.volume = CONFIG.soundPopVolume ?? 0.6;
			sndPiano = new Audio(CONFIG.soundPianoSrc);
			sndPiano.preload = 'auto';
			sndPiano.loop = !!CONFIG.soundPianoLoop;
			sndPiano.volume = CONFIG.soundPianoVolume ?? 0.25;
		} catch {}
	}


	// Create physics engine (no built-in canvas render; we sync DOM manually)
	const engine = Engine.create();
	const world = engine.world;
	world.gravity.y = CONFIG.gravity;
	engine.enableSleeping = true; // let bodies sleep when calm instead of making them static

	// Static ground
	let ground = Bodies.rectangle(W() / 2, H() + 20, Math.max(W(), 1200), 60, {
		isStatic: true,
		label: 'ground',
		render: { visible: false }
	});
	// Static side walls to keep words inside the scene
	const wallThickness = 80;
	let leftWall = Bodies.rectangle(-wallThickness / 2, H() / 2, wallThickness, Math.max(H(), 1200), {
		isStatic: true,
		label: 'wall-left',
		render: { visible: false }
	});
	let rightWall = Bodies.rectangle(W() + wallThickness / 2, H() / 2, wallThickness, Math.max(H(), 1200), {
		isStatic: true,
		label: 'wall-right',
		render: { visible: false }
	});
	Composite.add(world, [ground, leftWall, rightWall]);
	let boundariesRemoved = false;

	// Invisible 1x1 sensor at center to detect a touching word later
	let centerSensor = Bodies.rectangle(W() / 2, H() / 2, 1, 1, {
		isStatic: true,
		isSensor: true,
		label: 'center-sensor',
		render: { visible: false }
	});
	Composite.add(world, centerSensor);

	// Keep a mapping from body.id to DOM element
	const domById = new Map();

	// Utility: create a word element, measure size, and corresponding physics body
	function addWord(text) {
		const el = document.createElement('div');
		el.className = 'word';
		el.textContent = text;
		el.style.transform = 'translate(-9999px, -9999px)';
		// Apply configured font size before measuring
		if (CONFIG.fontSizePx != null) {
			el.style.fontSize = `${CONFIG.fontSizePx}px`;
		}
		scene.appendChild(el);

		// Measure element to size the body properly
		const rect = el.getBoundingClientRect();
		const width = Math.max(CONFIG.minWordWidth, rect.width);
		const height = Math.max(CONFIG.minWordHeight, rect.height);

		// Random spawn X near center with slight offset
		const spread = W() * CONFIG.spawnHorizontalSpread;
		let spawnX = W() / 2 + (Math.random() - 0.5) * spread;
		const spawnY = -(CONFIG.spawnHeightMin + Math.random() * CONFIG.spawnHeightRand);
		const angleDeg = CONFIG.rotationMinDeg + Math.random() * (CONFIG.rotationMaxDeg - CONFIG.rotationMinDeg);
		const angle = angleDeg * (Math.PI / 180);

		// Clamp spawn inside visible area
		const minX = width / 2 + 4;
		const maxX = W() - width / 2 - 4;
		if (maxX > minX) {
			spawnX = Math.min(maxX, Math.max(minX, spawnX));
		}

		// Rectangle body approximating the text box (minimal options)
		const body = Bodies.rectangle(spawnX, spawnY, width, height, {
			angle,
			chamfer: { radius: CONFIG.cornerRadius },
			label: 'word'
		});

		Composite.add(world, body);
		domById.set(body.id, el);
		el.dataset.bodyId = String(body.id);

		return body;
	}

	// Sync DOM positions on each tick
	Events.on(engine, 'afterUpdate', () => {
		domById.forEach((el, idStr) => {
			const id = Number(idStr);
			const body = world.bodies.find(b => b.id === id);
			if (!body) return;

			const { x, y } = body.position;
			const angle = body.angle;
			// Convert physics coords to DOM transform
			el.style.transform = `translate(${x - el.offsetWidth / 2}px, ${y - el.offsetHeight / 2}px) rotate(${angle}rad)`;

			// No manual freezing; sleeping handles calm bodies automatically
		});
	});

	// Keep ground width on resize; lightly nudge stacked bodies to settle
	let resizeTimeout;
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimeout);
		resizeTimeout = setTimeout(() => {
			// Replace ground and walls unless they've been removed by the blast
			if (!boundariesRemoved) {
				Composite.remove(world, ground);
				Composite.remove(world, leftWall);
				Composite.remove(world, rightWall);
				ground = Bodies.rectangle(W() / 2, H() + 20, Math.max(W(), 1200), 60, { isStatic: true, label: 'ground' });
				leftWall = Bodies.rectangle(-wallThickness / 2, H() / 2, wallThickness, Math.max(H(), 1200), { isStatic: true, label: 'wall-left' });
				rightWall = Bodies.rectangle(W() + wallThickness / 2, H() / 2, wallThickness, Math.max(H(), 1200), { isStatic: true, label: 'wall-right' });
				Composite.add(world, [ground, leftWall, rightWall]);
			}

			// Recreate or reposition the center sensor to the new center
			Composite.remove(world, centerSensor);
			centerSensor = Bodies.rectangle(W() / 2, H() / 2, 1, 1, { isStatic: true, isSensor: true, label: 'center-sensor' });
			Composite.add(world, centerSensor);

			// No jiggle needed; most words will be static after settling
		}, 150);
	});

	// Spawner state
	let wordIndex = 0;
	function nextWord() {
		const text = CONFIG.words[wordIndex % CONFIG.words.length];
		wordIndex++;
		return text;
	}

	// Spawn accounting and helpers
	let spawnedCount = 0;
	const canSpawnMore = () => (CONFIG.spawnLimit == null) || (spawnedCount < CONFIG.spawnLimit);
	function spawnOne() {
		if (!canSpawnMore()) return false;
		addWord(nextWord());
		spawnedCount++;
		return true;
	}

	let spawnTimer = null;
	let selectionScheduled = false;
	function finalizeSelection() {
		// Find words currently touching the center sensor; else pick the nearest to center
		const center = centerSensor.position;
		const wordBodies = world.bodies.filter(b => b.label === 'word');
		let touching = [];
		// Use Query.collides to find overlaps with sensor
		const pairs = Query.collides(centerSensor, wordBodies);
		if (pairs && pairs.length) {
			for (const p of pairs) {
				const other = p.bodyA === centerSensor ? p.bodyB : p.bodyA;
				touching.push(other);
			}
		}
		let chosen = null;
		if (touching.length) {
			// pick the one whose center is closest (in case of multiple)
			chosen = touching.reduce((best, b) => {
				const d2 = (b.position.x - center.x) ** 2 + (b.position.y - center.y) ** 2;
				if (!best || d2 < best.d2) return { b, d2 };
				return best;
			}, null)?.b || null;
		} else {
			// Nearest by distance to center
			chosen = wordBodies.reduce((best, b) => {
				const d2 = (b.position.x - center.x) ** 2 + (b.position.y - center.y) ** 2;
				if (!best || d2 < best.d2) return { b, d2 };
				return best;
			}, null)?.b || null;
		}
		if (!chosen) return;
		const el = domById.get(chosen.id) || domById.get(String(chosen.id));
		if (!el) return;

		// Blink in original color (no red yet). Wait for click to turn red and blast.
		const dur = CONFIG.redTransitionMs || 0;
		const opacityTrans = `opacity ${Math.max(150, dur || 400)}ms ease-in-out`;
		el.style.transition = el.style.transition ? `${el.style.transition}, ${opacityTrans}` : opacityTrans;
		let vis = true;
		const blinkInterval = setInterval(() => {
			vis = !vis;
			el.style.opacity = vis ? '1' : '0.35';
		}, Math.max(150, dur || 400));
		el.style.cursor = 'pointer';
		el.title = 'Click to blast';
		el.classList.add('glow-pop');
		const onClick = () => {
			clearInterval(blinkInterval);
			el.removeEventListener('click', onClick);
			el.style.cursor = '';
			el.classList.remove('glow-pop');
			el.style.opacity = '1';
			// Now turn red, then blast after the color transition
			const trans = `color ${dur}ms ease`;
			el.style.transition = el.style.transition ? `${el.style.transition}, ${trans}` : trans;
			requestAnimationFrame(() => { el.style.color = 'red'; });
			// Pre-play pop slightly before the blast
			const lead = CONFIG.soundPopPreMs ?? 100;
			const preDelay = Math.max(0, dur - Math.max(0, lead));
			setTimeout(() => {
				try {
					if (sndPop) { sndPop.currentTime = 0; sndPop.play().catch(() => {}); popPlayed = true; }
				} catch {}
			}, preDelay);
			setTimeout(() => triggerBlast(chosen, el), dur);
		};
		el.addEventListener('click', onClick);
	}

	function finalizeSelectionDelayed() {
		if (selectionScheduled) return;
		selectionScheduled = true;
		// give a brief moment for last body to enter the scene
		setTimeout(finalizeSelection, 600);
	}

	function startSpawning() {
		// Initial burst (respect spawnLimit)
		for (let i = 0; i < CONFIG.initialBurst; i++) {
			if (!spawnOne()) break;
		}

		// If we've reached the limit after the burst, don't start the timer
		if (!canSpawnMore()) {
			if (CONFIG.spawnLimit != null) finalizeSelectionDelayed();
			return;
		}

		// Drip feed (respect spawnLimit)
		spawnTimer = setInterval(() => {
			if (!spawnOne()) {
				clearInterval(spawnTimer);
				spawnTimer = null;
				if (CONFIG.spawnLimit != null) finalizeSelectionDelayed();
				return;
			}
			// cap total words to avoid runaway perf on idle tabs
			const activeIds = Array.from(domById.keys());
			if (activeIds.length > CONFIG.maxWords) {
				const toRemove = activeIds.slice(0, activeIds.length - CONFIG.maxWords);
				toRemove.forEach(idStr => {
					const id = Number(idStr);
					const body = world.bodies.find(b => b.id === id);
					const el = domById.get(idStr);
					if (body) Composite.remove(world, body);
					if (el && el.parentNode) el.parentNode.removeChild(el);
					domById.delete(idStr);
				});
			}
		}, CONFIG.spawnEveryMs);
	}

	// No bounce or collision impulses; we keep it minimal

	// Remove boundaries and blow all words outward from the chosen red word
	let blastTriggered = false;
	function removeBoundaries() {
		if (boundariesRemoved) return;
		if (ground) Composite.remove(world, ground);
		if (leftWall) Composite.remove(world, leftWall);
		if (rightWall) Composite.remove(world, rightWall);
		ground = null; leftWall = null; rightWall = null;
		boundariesRemoved = true;
	}

	function triggerBlast(chosenBody, chosenEl) {
		if (blastTriggered) return;
		blastTriggered = true;
		removeBoundaries();

		// If pop wasn't pre-played, play it now at blast time
		try { if (!popPlayed && sndPop) { sndPop.currentTime = 0; sndPop.play().catch(() => {}); popPlayed = true; } } catch {}

		const cx = chosenBody.position.x;
		const cy = chosenBody.position.y;
		const words = world.bodies.filter(b => b.label === 'word');

		// Visual shockwave
		try {
			const ring = document.createElement('div');
			ring.className = 'shockwave';
			ring.style.left = `${cx}px`;
			ring.style.top = `${cy}px`;
			scene.appendChild(ring);
			requestAnimationFrame(() => ring.classList.add('go'));
			setTimeout(() => ring.remove(), 700);

			// Explosion particles
			const particles = CONFIG.particleCount || 24;
			for (let i = 0; i < particles; i++) {
				const p = document.createElement('div');
				p.className = 'particle';
				p.style.left = `${cx}px`;
				p.style.top = `${cy}px`;
				// match chosen color if available
				if (chosenEl) p.style.color = getComputedStyle(chosenEl).color;
				const ang = (i / particles) * Math.PI * 2 + Math.random() * 0.35;
				const len = 180 + Math.random() * (CONFIG.particleMaxLen || 300);
				const size = 3 + Math.random() * 4;
				p.style.width = `${size}px`;
				p.style.height = `${size}px`;
				p.style.setProperty('--dx', `${Math.cos(ang) * len}px`);
				p.style.setProperty('--dy', `${Math.sin(ang) * len}px`);
				scene.appendChild(p);
				requestAnimationFrame(() => p.classList.add('fly'));
				setTimeout(() => p.remove(), 800);
			}
		} catch {}

		// Camera shake
		try { shakeScene(CONFIG.shakeMs || 400, CONFIG.shakeMag || 8); } catch {}

		// Initial impulse with distance falloff
		words.forEach(b => {
			if (b === chosenBody) return;
			// Wake up the body if sleeping
			try { Sleeping.set(b, false); } catch {}
			const dx = b.position.x - cx;
			const dy = b.position.y - cy;
			const d = Math.max(8, Math.hypot(dx, dy));
			const nx = dx / d;
			const ny = dy / d;
			// Outward kick: closer gets more speed
			const falloff = 1 / Math.max(0.6, d / 160);
			const base = CONFIG.blastStrength || 30;
			const speed = base * falloff * (0.85 + Math.random() * 0.4);
			Body.setVelocity(b, { x: nx * speed, y: ny * speed });
			Body.setAngularVelocity(b, (Math.random() - 0.5) * (CONFIG.blastSpin || 2));
		});

		// Short outward wind that decays over time for a more natural blast
		const windEnd = performance.now() + (CONFIG.blastWindMs || 600);
		const windBase = CONFIG.blastWindForce || 0.0008;
		const windTick = (e) => {
			const now = performance.now();
			if (now >= windEnd) { Events.off(engine, 'beforeUpdate', windTick); return; }
			const t = (windEnd - now) / (CONFIG.blastWindMs || 600); // 1 -> 0
			const mult = t * t; // ease out
			for (const b of words) {
				if (b === chosenBody || b.isStatic) continue;
				const dx = b.position.x - cx;
				const dy = b.position.y - cy;
				const d = Math.max(20, Math.hypot(dx, dy));
				const nx = dx / d;
				const ny = dy / d;
				Body.applyForce(b, b.position, { x: nx * windBase * mult, y: ny * windBase * mult });
			}
		};
		Events.on(engine, 'beforeUpdate', windTick);

		// Fade out the chosen word and remove it
		if (chosenEl) {
			const t = chosenEl.style.transition ? chosenEl.style.transition + ', opacity 300ms ease' : 'opacity 300ms ease';
			chosenEl.style.transition = t;
			requestAnimationFrame(() => { chosenEl.style.opacity = '0'; });
			setTimeout(() => {
				// Remove DOM and body for the chosen word
				if (chosenEl.parentNode) chosenEl.parentNode.removeChild(chosenEl);
				domById.forEach((el, idStr) => {
					if (el === chosenEl) {
						const id = Number(idStr);
						const body = world.bodies.find(b => b.id === id);
						if (body) Composite.remove(world, body);
						domById.delete(idStr);
					}
				});
			}, 320);
		}

		// Start piano shortly after the blast
		const musicDelay = CONFIG.soundPianoDelayMs ?? 600;
		setTimeout(() => { try { sndPiano && sndPiano.play().catch(() => {}); } catch {} }, musicDelay);

		// Schedule post-blast messages
		const delay = CONFIG.postMessageDelayMs ?? 3000;
		setTimeout(() => { try { showPostMessages(); } catch {} }, delay);
	}

	// Simple camera shake on #scene
	function shakeScene(durationMs, magnitudePx) {
		const start = performance.now();
		const mag = magnitudePx || 8;
		const dur = durationMs || 400;
		const apply = () => {
			const now = performance.now();
			const t = (now - start) / dur;
			if (t >= 1) { scene.style.transform = ''; return; }
			const damp = (1 - t) * (1 - t);
			const x = (Math.random() * 2 - 1) * mag * damp;
			const y = (Math.random() * 2 - 1) * mag * damp;
			scene.style.transform = `translate(${x}px, ${y}px)`;
			requestAnimationFrame(apply);
		};
		apply();
	}

	// Create and fade-in sequential post-blast messages
	function showPostMessages() {
		const msgs = Array.isArray(CONFIG.postMessages) && CONFIG.postMessages.length
			? CONFIG.postMessages
			: ["Happy Birthday!", "Wishing you joy and love", "Have an amazing day!"];
		const fadeMs = CONFIG.postMessageFadeMs ?? 800;
		const staggerMs = CONFIG.postMessageStaggerMs ?? 600;

		const overlay = document.createElement('div');
		overlay.className = 'post-overlay';
		const box = document.createElement('div');
		box.className = 'post-box';
		overlay.appendChild(box);
		document.body.appendChild(overlay);

		// Match font size (and weight) to falling words, unless overridden
		try {
			const computed = parseFloat(getComputedStyle(document.querySelector('.word') || document.body).fontSize);
			const px = (CONFIG.postMessageFontSizePx ?? CONFIG.fontSizePx ?? computed) ?? 18;
			box.style.fontSize = `${px}px`;
			box.style.fontWeight = '700';
		} catch {}

		// Increase spacing between lines using CSS grid gap
		box.style.display = 'grid';
		box.style.rowGap = `${CONFIG.postMessageLineGapPx ?? 24}px`;

		const lines = msgs.map((m) => {
			const line = document.createElement('div');
			line.className = 'post-line';
			line.textContent = m;
			line.style.transition = `opacity ${fadeMs}ms ease, transform ${fadeMs}ms ease`;
			box.appendChild(line);
			return line;
		});

		// Commit initial hidden state before transitioning (fixes first-line instant jump)
		void box.offsetHeight; // layout flush

		lines.forEach((line, i) => {
			const start = () => {
				line.style.opacity = '1';
				line.style.transform = 'translateY(0)';
				// All lines get the same premium glow
				line.classList.add('post-glow');
				// If this is the last line and it's now visible, start emoji sprinkle behind the box
				if (i === lines.length - 1) {
					startEmojiSprinkle(overlay, box);
				}
			};
			const delay = i * staggerMs;
			setTimeout(() => {
				if (i === 0) {
					// Double rAF to ensure a paint with initial styles occurred
					requestAnimationFrame(() => requestAnimationFrame(start));
				} else {
					requestAnimationFrame(start);
				}
			}, delay);
		});
	}

	// ---------------- Emoji Sprinkle ----------------
	function startEmojiSprinkle(overlay, box) {
		const cfg = CONFIG.emojiSprinkle || {};
		const emojis = Array.isArray(cfg.emojis) && cfg.emojis.length ? cfg.emojis : ["❤️", "✨", "🌸"];
		const fontSize = Math.max(8, cfg.fontSize ?? 24);
		const spawnInterval = Math.max(60, cfg.spawnInterval ?? 800);
		const distMin = Math.max(0, (cfg.distanceRange?.[0] ?? 10));
		const distMax = Math.max(distMin, (cfg.distanceRange?.[1] ?? 20));
		const offMin = cfg.offsetRange?.[0] ?? -40;
		const offMax = cfg.offsetRange?.[1] ?? 40;

		// Expand the no-spawn zone: explicit noSpawnPadPx overrides offsetRange magnitude
		const noSpawnPad = Math.max(8, (cfg.noSpawnPadPx != null ? Number(cfg.noSpawnPadPx) : Math.max(Math.abs(offMin), Math.abs(offMax))));

		// Create or reuse the emoji layer behind text
		let layer = overlay.querySelector('.emoji-layer');
		if (!layer) {
			layer = document.createElement('div');
			layer.className = 'emoji-layer';
			overlay.appendChild(layer);
		}

		// Track placed emoji positions for spacing
		const placed = [];

		// Compute the no-spawn zone from the message box bounding rect
		function getNoSpawnRect() {
			const r = box.getBoundingClientRect();
			return { x: r.left, y: r.top, w: r.width, h: r.height };
		}

		function isInsideNoSpawn(x, y) {
			const ns = getNoSpawnRect();
			return x >= ns.x - noSpawnPad && x <= ns.x + ns.w + noSpawnPad && y >= ns.y - noSpawnPad && y <= ns.y + ns.h + noSpawnPad;
		}

		function farFromOthers(x, y, requiredMin) {
			if (!placed.length) return true;
			for (const p of placed) {
				const d = Math.hypot(x - p.x, y - p.y);
				if (d < Math.max(requiredMin, p.minDist)) return false;
			}
			return true;
		}

		// Build grid intersection points dynamically based on screen size and target spacing
		function buildGridPoints() {
			const sceneRect = overlay.getBoundingClientRect();
			const width = sceneRect.width;
			const height = sceneRect.height;
			// Grid cell size = fontSize * scale (configurable), fallback to spacing midpoint
			const scale = Math.max(0.5, cfg.gridCellScale ?? 2);
			const cell = Math.max(6, fontSize * scale, (distMin + distMax) / 2);
			const cols = Math.max(2, Math.floor(width / cell));
			const rows = Math.max(2, Math.floor(height / cell));
			const stepX = cols > 0 ? width / cols : width;
			const stepY = rows > 0 ? height / rows : height;
			// Padding from edges so emoji is fully visible (approx half glyph size)
			const edgePad = Math.ceil(fontSize * 0.6);
			const pts = [];
			for (let i = 0; i <= cols; i++) {
				for (let j = 0; j <= rows; j++) {
					const px = sceneRect.left + i * stepX;
					const py = sceneRect.top + j * stepY;
					// Exclude intersections near edges which would clip the emoji
					if (px < sceneRect.left + edgePad || px > sceneRect.right - edgePad || py < sceneRect.top + edgePad || py > sceneRect.bottom - edgePad) {
						continue;
					}
					// Skip the no-spawn zone around the message
					if (isInsideNoSpawn(px, py)) continue;
					pts.push({
						pageX: px,
						pageY: py,
						x: px - sceneRect.left,
						y: py - sceneRect.top
					});
				}
			}
			// Shuffle for random spawn order on the grid
			for (let k = pts.length - 1; k > 0; k--) {
				const r = Math.floor(Math.random() * (k + 1));
				[pts[k], pts[r]] = [pts[r], pts[k]];
			}
			return pts;
		}

		function spawnEmojiAt(x, y, minDist) {
			const span = document.createElement('span');
			span.className = 'emoji';
			span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
			span.style.fontSize = `${fontSize}px`;
			span.style.left = `${x}px`;
			span.style.top = `${y}px`;
			layer.appendChild(span);
			// Animate in
			requestAnimationFrame(() => span.classList.add('in'));
			// Track
			const sceneRect = overlay.getBoundingClientRect();
			placed.push({ x: sceneRect.left + x, y: sceneRect.top + y, minDist });
		}

		const points = buildGridPoints();
		let idx = 0;
		let currentInterval = spawnInterval;
		const slowdown = Math.max(0, cfg.spawnSlowdownMsPerSpawn ?? 0);
		function step() {
			// Spawn until we've filled all eligible intersections
			if (idx >= points.length) return;
			const p = points[idx++];
			// Track and spawn at this intersection
			placed.push({ x: p.pageX, y: p.pageY, minDist: (distMin + distMax) / 2 });
			spawnEmojiAt(p.x, p.y, (distMin + distMax) / 2);
			currentInterval += slowdown;
			setTimeout(step, currentInterval);
		}
		setTimeout(step, currentInterval);
	}

	// Run the engine (paused until user starts spawning)
	const runner = Runner.create();
	Runner.run(runner, engine);


	// Start button behavior
	startBtn?.addEventListener('click', () => {
		overlay?.parentNode?.removeChild(overlay);
		// ensure gravity is applied from CONFIG (in case tweaked via DevTools)
		world.gravity.y = CONFIG.gravity;
		// Initialize audio under a user gesture to satisfy autoplay policies
		if (!sndPop || !sndPiano) initAudio();
		if (!spawnTimer) startSpawning();
	});
})();


