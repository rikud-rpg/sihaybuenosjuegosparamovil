let db = null;
const state = {
    selectedTags: new Set(),
    selectedStudio: "ALL",
    selectedAvailability: "ALL",
    searchQuery: "",
    sortMode: "az"
};

const hoverTimers = {};
const activeSelectedSecuela = {};

window.addEventListener('DOMContentLoaded', async () => {
    try {
        const SQL = await initSqlJs({
            locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
        });

        const response = await fetch('juegos.db');
        if (response.ok) {
            const buf = await response.arrayBuffer();
            db = new SQL.Database(new Uint8Array(buf));
        } else {
            db = new SQL.Database();
            initRelationalDatabase();
        }

        renderTags();
        populateStudiosDropdown();
        setupEventListeners();
        applyFiltersAndRender();
    } catch (err) {
        console.error("Error cargando SQLite:", err);
    }
});

function initRelationalDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS juegos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            estudio TEXT NOT NULL,
            anio INTEGER NOT NULL,
            esTop INTEGER DEFAULT 0,
            disponible INTEGER DEFAULT 1,
            url TEXT,
            banner TEXT,
            video TEXT,
            reviewHTML TEXT
        );

        CREATE TABLE IF NOT EXISTS secuelas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            juego_id INTEGER NOT NULL,
            nombre TEXT NOT NULL,
            anio INTEGER NOT NULL,
            esTop INTEGER DEFAULT 0,
            disponible INTEGER DEFAULT 1,
            url TEXT,
            banner TEXT,
            video TEXT,
            reviewHTML TEXT,
            FOREIGN KEY(juego_id) REFERENCES juegos(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS etiquetas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT UNIQUE NOT NULL
        );

        CREATE TABLE IF NOT EXISTS juego_etiquetas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            juego_id INTEGER,
            secuela_id INTEGER,
            etiqueta_id INTEGER NOT NULL,
            FOREIGN KEY(juego_id) REFERENCES juegos(id) ON DELETE CASCADE,
            FOREIGN KEY(secuela_id) REFERENCES secuelas(id) ON DELETE CASCADE,
            FOREIGN KEY(etiqueta_id) REFERENCES etiquetas(id) ON DELETE CASCADE
        );
    `);

    // Insertar etiquetas por defecto
    const defaultTags = ["Historia", "Sin Historia", "Offline", "Online", "Plataforma", "FPS", "MOBA", "Premium", "Gratis", "Original (Móvil)", "Competitivo", "Deportes", "Casual", "Carreras", "Español", "Anime", "Ports (Oficiales)", "Estrategia", "Pixel Art"];
    defaultTags.forEach(t => db.run(`INSERT OR IGNORE INTO etiquetas (nombre) VALUES ('${t}');`));

    // Datos iniciales de demostración
    db.run(`INSERT INTO juegos (id, nombre, estudio, anio, esTop, disponible, url, banner, video, reviewHTML) VALUES (1, 'Punishing: Gray Raven', 'Kuro Games', 2019, 1, 1, 'https://play.google.com/store/apps/details?id=com.kurogame.gplay.punishing.grayraven.en', 'https://images8.alphacoders.com/129/thumb-1920-1296146.png', 'https://youtu.be/smmh3-8IW_Y?t=40', '<div class="space-y-3"><p><strong>Punishing: Gray Raven</strong> es un juego Hack and Slash increíble...</p></div>');`);
    
    // Relacionar etiquetas con el juego 1
    const tagsPGR = ["Online", "Anime", "Original (Móvil)", "FPS", "Historia", "Gratis"];
    tagsPGR.forEach(t => {
        db.run(`INSERT INTO juego_etiquetas (juego_id, etiqueta_id) SELECT 1, id FROM etiquetas WHERE nombre = '${t}';`);
    });
}

function getAvailableTags() {
    const res = db.exec("SELECT nombre FROM etiquetas ORDER BY nombre ASC");
    if (!res.length) return [];
    return res[0].values.map(r => r[0]);
}

function getJuegosFromDB() {
    const res = db.exec("SELECT * FROM juegos");
    if (!res.length) return [];

    const rows = res[0].values;
    const cols = res[0].columns;

    return rows.map(r => {
        const juego = {};
        cols.forEach((col, idx) => juego[col] = r[idx]);
        
        juego.esTop = Boolean(juego.esTop);
        juego.disponible = Boolean(juego.disponible);

        // Cargar etiquetas del juego principal mediante JOIN relacional
        const tagRes = db.exec(`
            SELECT e.nombre FROM etiquetas e
            JOIN juego_etiquetas je ON e.id = je.etiqueta_id
            WHERE je.juego_id = ${juego.id}
        `);
        juego.etiquetas = tagRes.length ? tagRes[0].values.map(tr => tr[0]) : [];

        // CREAR LISTA UNIFICADA: Juego Principal (Índice 0) + Secuelas (Índice 1+)
        let listaVersiones = [];

        // 1. Añadir el juego principal como la primera opción por defecto
        listaVersiones.push({
            id: 'main-' + juego.id,
            nombre: juego.nombre,
            anio: juego.anio,
            disponible: juego.disponible,
            esTop: juego.esTop,
            url: juego.url,
            banner: juego.banner,
            video: juego.video,
            reviewHTML: juego.reviewHTML,
            etiquetas: juego.etiquetas
        });

        // 2. Consultar y añadir las secuelas asociadas
        const secRes = db.exec(`SELECT * FROM secuelas WHERE juego_id = ${juego.id}`);
        if (secRes.length) {
            const secCols = secRes[0].columns;
            const secuelasDB = secRes[0].values.map(sr => {
                const sec = {};
                secCols.forEach((scol, sidx) => sec[scol] = sr[sidx]);
                sec.esTop = sec.esTop !== null ? Boolean(sec.esTop) : undefined;
                sec.disponible = sec.disponible !== null ? Boolean(sec.disponible) : undefined;

                // Cargar etiquetas de la secuela
                const secTagRes = db.exec(`
                    SELECT e.nombre FROM etiquetas e
                    JOIN juego_etiquetas je ON e.id = je.etiqueta_id
                    WHERE je.secuela_id = ${sec.id}
                `);
                sec.etiquetas = secTagRes.length ? secTagRes[0].values.map(str => str[0]) : juego.etiquetas;
                if (!sec.banner) sec.banner = juego.banner; // Hereda banner si está vacío
                return sec;
            });
            listaVersiones = listaVersiones.concat(secuelasDB);
        }

        // Asignamos la lista unificada a la propiedad secuelas del juego
        juego.secuelas = listaVersiones;
        return juego;
    });
}
function renderTags() {
    const container = document.getElementById('tagsContainer');
    const tags = getAvailableTags();
    container.innerHTML = tags.map(tag => `
        <button onclick="toggleTag('${tag}')" id="tag-${tag}" 
            class="px-3 py-1 rounded-full border border-gamer-border bg-gray-950 text-gray-300 text-xs font-semibold hover:border-emerald-400 hover:text-white transition duration-200">
            ${tag}
        </button>
    `).join('');
}

function populateStudiosDropdown() {
    const select = document.getElementById('studioFilter');
    const juegos = getJuegosFromDB();
    const estudios = Array.from(new Set(juegos.map(j => j.estudio))).sort();
    
    select.innerHTML = '<option value="ALL">Todos los Estudios</option>';
    estudios.forEach(estudio => {
        const opt = document.createElement('option');
        opt.value = estudio;
        opt.textContent = estudio;
        select.appendChild(opt);
    });
}

function setupEventListeners() {
    document.getElementById('searchInput').addEventListener('input', (e) => {
        state.searchQuery = e.target.value.toLowerCase().trim();
        applyFiltersAndRender();
    });
    document.getElementById('studioFilter').addEventListener('change', (e) => {
        state.selectedStudio = e.target.value;
        applyFiltersAndRender();
    });
    document.getElementById('availabilityFilter').addEventListener('change', (e) => {
        state.selectedAvailability = e.target.value;
        applyFiltersAndRender();
    });
}

function toggleTag(tag) {
    if (state.selectedTags.has(tag)) state.selectedTags.delete(tag);
    else state.selectedTags.add(tag);
    updateTagStyles();
    applyFiltersAndRender();
}

function updateTagStyles() {
    getAvailableTags().forEach(tag => {
        const btn = document.getElementById(`tag-${tag}`);
        if (!btn) return;
        if (state.selectedTags.has(tag)) {
            btn.className = "px-3 py-1 rounded-full tag-active text-xs font-semibold transition duration-200";
        } else {
            btn.className = "px-3 py-1 rounded-full border border-gamer-border bg-gray-950 text-gray-300 text-xs font-semibold hover:border-emerald-400 hover:text-white transition duration-200";
        }
    });
}

function setSortMode(mode) {
    state.sortMode = mode;
    
    const btnAZ = document.getElementById('sortAZ');
    const btnZA = document.getElementById('sortZA');
    const btnNew = document.getElementById('sortYearNew');
    const btnOld = document.getElementById('sortYearOld');
    const btnBests = document.getElementById('sortBests');

    [btnAZ, btnZA, btnNew, btnOld, btnBests].forEach(btn => {
        btn.classList.remove('bg-emerald-500/20', 'border-emerald-400', 'text-emerald-300', 'bg-yellow-500/20', 'border-yellow-500', 'text-yellow-400');
    });

    if (mode === 'az') btnAZ.classList.add('bg-emerald-500/20', 'border-emerald-400', 'text-emerald-300');
    if (mode === 'za') btnZA.classList.add('bg-emerald-500/20', 'border-emerald-400', 'text-emerald-300');
    if (mode === 'year-desc') btnNew.classList.add('bg-emerald-500/20', 'border-emerald-400', 'text-emerald-300');
    if (mode === 'year-asc') btnOld.classList.add('bg-emerald-500/20', 'border-emerald-400', 'text-emerald-300');
    if (mode === 'bests') btnBests.classList.add('bg-yellow-500/20', 'border-yellow-500', 'text-yellow-400');

    applyFiltersAndRender();
}

function applyFiltersAndRender() {
    const juegos = getJuegosFromDB();

    let resultado = juegos.filter(juego => {
        const secuelaActiva = juego.secuelas[0] || juego;
        const esDisponible = secuelaActiva.disponible !== undefined ? secuelaActiva.disponible : juego.disponible;

        if (state.selectedStudio !== "ALL" && juego.estudio !== state.selectedStudio) return false;
        if (state.selectedAvailability === "AVAILABLE" && !esDisponible) return false;
        if (state.selectedAvailability === "UNAVAILABLE" && esDisponible) return false;
        if (state.searchQuery && !juego.nombre.toLowerCase().includes(state.searchQuery)) return false;

        if (state.selectedTags.size > 0) {
            const todasLasEtiquetas = new Set([
                ...(juego.etiquetas || []),
                ...(juego.secuelas?.flatMap(s => s.etiquetas || []) || [])
            ]);
            for (let tag of state.selectedTags) {
                if (!todasLasEtiquetas.has(tag)) return false;
            }
        }
        return true;
    });

    resultado.sort((a, b) => {
        const aTop = a.esTop || a.secuelas.some(s => s.esTop);
        const bTop = b.esTop || b.secuelas.some(s => s.esTop);

        if (state.sortMode === 'az') return a.nombre.localeCompare(b.nombre);
        if (state.sortMode === 'za') return b.nombre.localeCompare(a.nombre);
        if (state.sortMode === 'year-desc') return (b.secuelas[0]?.anio || b.anio) - (a.secuelas[0]?.anio || a.anio);
        if (state.sortMode === 'year-asc') return (a.secuelas[0]?.anio || a.anio) - (b.secuelas[0]?.anio || b.anio);
        if (state.sortMode === 'bests') {
            if (bTop !== aTop) return bTop - aTop;
            return a.nombre.localeCompare(b.nombre);
        }
        return 0;
    });

    renderGrid(resultado);
}

function renderGrid(juegos) {
    const grid = document.getElementById('gamesGrid');
    const countEl = document.getElementById('gameCount');
    const noResults = document.getElementById('noResults');

    countEl.textContent = `${juegos.length} ${juegos.length === 1 ? 'juego encontrado' : 'juegos encontrados'}`;
    if (juegos.length === 0) {
        grid.innerHTML = "";
        noResults.classList.remove('hidden');
        noResults.classList.add('flex');
        return;
    }
    noResults.classList.add('hidden');
    noResults.classList.remove('flex');

    grid.innerHTML = juegos.map(juego => {
        const secuelaInicial = juego.secuelas[0] || { 
            nombre: juego.nombre, 
            url: "#", 
            banner: juego.banner, 
            video: juego.video, 
            etiquetas: juego.etiquetas,
            disponible: juego.disponible,
            esTop: juego.esTop,
            reviewHTML: juego.reviewHTML
        };
        
        const esDisponible = secuelaInicial.disponible !== undefined ? secuelaInicial.disponible : juego.disponible;
        const esTop = secuelaInicial.esTop !== undefined ? secuelaInicial.esTop : juego.esTop;
        const etiquetasVisibles = secuelaInicial.etiquetas || juego.etiquetas;
        const enlaceInicial = (esDisponible && secuelaInicial.url && secuelaInicial.url !== "#") 
            ? `href="${secuelaInicial.url}" target="_blank" rel="noopener noreferrer"` 
            : `href="#" onclick="return false;"`;

        return `
        <div class="game-card relative bg-gamer-card border border-gamer-border overflow-hidden neon-border flex flex-col h-[360px] group transition-all duration-300 shadow-xl"
             onmouseenter="handleCardMouseEnter(${juego.id})" 
             onmouseleave="handleCardMouseLeave(${juego.id})">
            
            <div id="card-bg-${juego.id}" class="game-card-bg absolute inset-0 bg-cover bg-center" style="background-image: url('${secuelaInicial.banner}');"></div>
            <div id="card-video-container-${juego.id}" class="game-card-video-container" data-video="${secuelaInicial.video || ''}"></div>
            <div class="absolute inset-0 bg-gradient-to-t from-gray-950 via-gray-950/75 to-transparent z-10 pointer-events-none"></div>

            <div id="card-badges-${juego.id}" class="absolute top-3 left-3 z-20 flex flex-col gap-1 items-start">
                ${!esDisponible 
                    ? `<span class="px-2 py-0.5 rounded-md bg-red-600/90 text-white text-[10px] font-extrabold uppercase tracking-wider backdrop-blur-md shadow-lg border border-red-400/30"><i class="fa-solid fa-ban mr-1"></i> Cerrados</span>`
                    : `<span class="px-2 py-0.5 rounded-md bg-emerald-500/90 text-gray-950 text-[10px] font-extrabold uppercase tracking-wider backdrop-blur-md shadow-lg border border-emerald-300/30"><i class="fa-solid fa-check mr-1"></i> Disponible</span>`
                }
                ${esTop ? `<span class="px-2 py-0.5 rounded-md bg-yellow-500/90 text-gray-950 text-[10px] font-extrabold uppercase tracking-wider backdrop-blur-md shadow-lg border border-yellow-300/30"><i class="fa-solid fa-star mr-1"></i> Top Game</span>` : ''}
            </div>

            <div class="absolute top-3 right-3 z-20">
                <span id="card-year-${juego.id}" class="px-2 py-0.5 rounded-md bg-gray-950/80 text-emerald-300 text-[11px] font-bold border border-emerald-500/40 backdrop-blur-md">
                    ${secuelaInicial.anio || juego.anio || '2026'}
                </span>
            </div>

            <div class="relative z-20 mt-auto p-4 flex flex-col justify-end">
                <span class="text-[11px] font-bold tracking-widest text-emerald-400 uppercase mb-0.5">${juego.estudio}</span>

                <div class="flex items-center justify-between mb-2">
                    <h3 class="text-lg font-extrabold text-white leading-tight group-hover:text-emerald-300 transition line-clamp-1">
                        <a id="card-link-${juego.id}" ${enlaceInicial} class="hover:underline">
                            ${secuelaInicial.nombre || juego.nombre} <i class="fa-solid fa-arrow-up-right-from-square text-xs ml-1 opacity-70"></i>
                        </a>
                    </h3>
                    
                    <button onclick="openReviewModal(${juego.id})" title="Ver Reseña Completa" 
                            class="w-8 h-8 rounded-lg bg-gray-900/90 border border-emerald-500/40 hover:border-emerald-400 text-emerald-400 flex items-center justify-center text-xs transition shadow-md shrink-0 z-30">
                        <i class="fa-solid fa-book-open"></i>
                    </button>
                </div>

                <div id="card-tags-${juego.id}" class="flex flex-wrap gap-1 mb-3">
                    ${etiquetasVisibles.slice(0, 3).map(tag => `<span class="px-1.5 py-0.5 rounded bg-gray-950/80 border border-gray-800 text-emerald-200/90 text-[10px]">${tag}</span>`).join('')}
                </div>

                <div class="relative mt-1 z-30">
                    <select onchange="handleSecuelaSelection(${juego.id}, this.value)" 
                            class="w-full appearance-none bg-gray-950/90 border border-emerald-500/50 hover:border-emerald-400 text-emerald-300 font-semibold text-xs px-3 py-2 pr-8 focus:outline-none cursor-pointer transition shadow-md backdrop-blur-sm">
                        ${juego.secuelas.length > 0 ? juego.secuelas.map((sec, idx) => `<option value="${idx}" class="bg-gray-950 text-white font-sans">🎮 ${sec.nombre}</option>`).join('') : `<option value="0" class="bg-gray-950 text-white font-sans">🎮 ${juego.nombre}</option>`}
                    </select>
                    <i class="fa-solid fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-emerald-400 text-xs pointer-events-none"></i>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

function handleSecuelaSelection(juegoId, indexSecuela) {
    const juegos = getJuegosFromDB();
    const juego = juegos.find(j => j.id === juegoId);
    if (!juego) return;

    const secuela = juego.secuelas.length > 0 ? juego.secuelas[indexSecuela] : juego;
    activeSelectedSecuela[juegoId] = indexSecuela;

    const bgEl = document.getElementById(`card-bg-${juegoId}`);
    const container = document.getElementById(`card-video-container-${juegoId}`);
    const linkEl = document.getElementById(`card-link-${juegoId}`);
    const yearEl = document.getElementById(`card-year-${juegoId}`);
    const tagsEl = document.getElementById(`card-tags-${juegoId}`);
    const badgesEl = document.getElementById(`card-badges-${juegoId}`);

    const esDisponible = secuela.disponible !== undefined ? secuela.disponible : juego.disponible;
    const esTop = secuela.esTop !== undefined ? secuela.esTop : juego.esTop;

    if (bgEl && secuela.banner) bgEl.style.backgroundImage = `url('${secuela.banner}')`;

    if (badgesEl) {
        badgesEl.innerHTML = `
            ${!esDisponible 
                ? `<span class="px-2 py-0.5 rounded-md bg-red-600/90 text-white text-[10px] font-extrabold uppercase tracking-wider backdrop-blur-md shadow-lg border border-red-400/30"><i class="fa-solid fa-ban mr-1"></i> Cerrados</span>`
                : `<span class="px-2 py-0.5 rounded-md bg-emerald-500/90 text-gray-950 text-[10px] font-extrabold uppercase tracking-wider backdrop-blur-md shadow-lg border border-emerald-300/30"><i class="fa-solid fa-check mr-1"></i> Disponible</span>`
            }
            ${esTop ? `<span class="px-2 py-0.5 rounded-md bg-yellow-500/90 text-gray-950 text-[10px] font-extrabold uppercase tracking-wider backdrop-blur-md shadow-lg border border-yellow-300/30"><i class="fa-solid fa-star mr-1"></i> Top Game</span>` : ''}
        `;
    }

    if (yearEl) yearEl.textContent = secuela.anio || juego.anio || '2026';
    if (container) {
        container.classList.remove('playing');
        container.innerHTML = '';
        container.dataset.video = secuela.video || '';
    }

    if (linkEl) {
        linkEl.innerHTML = `${secuela.nombre || juego.nombre} <i class="fa-solid fa-arrow-up-right-from-square text-xs ml-1 opacity-70"></i>`;
        if (esDisponible && secuela.url && secuela.url !== "#") {
            linkEl.href = secuela.url;
            linkEl.target = "_blank";
            linkEl.rel = "noopener noreferrer";
            linkEl.removeAttribute("onclick");
        } else {
            linkEl.href = "#";
            linkEl.removeAttribute("target");
            linkEl.setAttribute("onclick", "return false;");
        }
    }

    if (tagsEl) {
        const etiquetasVisibles = secuela.etiquetas || juego.etiquetas;
        tagsEl.innerHTML = etiquetasVisibles.slice(0, 3).map(tag => `<span class="px-1.5 py-0.5 rounded bg-gray-950/80 border border-gray-800 text-emerald-200/90 text-[10px]">${tag}</span>`).join('');
    }
}

function openReviewModal(juegoId) {
    const juegos = getJuegosFromDB();
    const juego = juegos.find(j => j.id === juegoId);
    if (!juego) return;

    const idx = activeSelectedSecuela[juegoId] || 0;
    const secuela = juego.secuelas.length > 0 ? juego.secuelas[idx] : juego;

    const contenidoHTML = secuela.reviewHTML || juego.reviewHTML || `
        <div class="p-4 bg-gray-950 rounded-lg border border-gamer-border text-center text-gray-400">
            <i class="fa-solid fa-circle-info text-emerald-400 text-2xl mb-2"></i>
            <p>Reseña en proceso de redacción para esta versión.</p>
        </div>
    `;

    document.getElementById('modalGameTitle').textContent = secuela.nombre || juego.nombre;
    document.getElementById('modalGameContent').innerHTML = contenidoHTML;
    document.getElementById('reviewModal').classList.remove('hidden');
}

function closeReviewModal() {
    document.getElementById('reviewModal').classList.add('hidden');
}

function getYouTubeId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function getYouTubeStartTime(url) {
    if (!url) return 0;
    const match = url.match(/[?&]t=([^&]+)/);
    if (!match) return 0;
    const timeStr = match[1].replace('s', '');
    if (timeStr.includes('m')) {
        const parts = timeStr.split('m');
        return (parseInt(parts[0], 10) * 60) + (parseInt(parts[1], 10) || 0);
    }
    return parseInt(timeStr, 10) || 0;
}

function handleCardMouseEnter(juegoId) {
    if (hoverTimers[juegoId]) clearTimeout(hoverTimers[juegoId]);
    hoverTimers[juegoId] = setTimeout(() => {
        const container = document.getElementById(`card-video-container-${juegoId}`);
        if (!container) return;
        const videoUrl = container.dataset.video;
        if (!videoUrl || videoUrl.trim() === '' || videoUrl === '#') return;

        const ytId = getYouTubeId(videoUrl);
        if (ytId) {
            const startParam = getYouTubeStartTime(videoUrl) > 0 ? `&start=${getYouTubeStartTime(videoUrl)}` : '';
            container.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${ytId}&enablejsapi=1&playsinline=1${startParam}" allow="autoplay; encrypted-media" frameborder="0"></iframe>`;
            container.classList.add('playing');
        }
    }, 3000);
}

function handleCardMouseLeave(juegoId) {
    if (hoverTimers[juegoId]) {
        clearTimeout(hoverTimers[juegoId]);
        delete hoverTimers[juegoId];
    }
    const container = document.getElementById(`card-video-container-${juegoId}`);
    if (container) {
        container.classList.remove('playing');
        container.innerHTML = '';
    }
}

function resetFilters() {
    state.selectedTags.clear();
    state.selectedStudio = "ALL";
    state.selectedAvailability = "ALL";
    state.searchQuery = "";
    state.sortMode = "az";
    document.getElementById('searchInput').value = "";
    document.getElementById('studioFilter').value = "ALL";
    document.getElementById('availabilityFilter').value = "ALL";
    updateTagStyles();
    setSortMode('az');
}