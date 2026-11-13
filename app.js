// app.js
// Lógica de UI, envío resiliente (Outbox) y registro de Background Sync.

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const ETIQUETA_SYNC = 'sync-reportes';

const formulario = document.getElementById('form-incidencia');
const inputTitulo = document.getElementById('titulo');
const inputDescripcion = document.getElementById('descripcion');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');

// ---------- Service Worker: registro y puente de mensajes ----------

if ('serviceWorker' in navigator) {
  // Ruta relativa: en GitHub Pages el sitio vive en /pwa-outbox-practica/
  navigator.serviceWorker.register('./sw.js')
    .then((registro) => {
      console.log('[SW] Registrado con scope:', registro.scope);
    })
    .catch((error) => {
      console.error('[SW] Falla al registrar:', error);
    });

  // Mitad receptora del puente: el SW avisa que terminó de sincronizar
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });
}

// ---------- Indicador de red ----------

function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}

// ---------- READ: dibujar la bandeja de salida ----------

function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      listaOutbox.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'vacio';
        vacio.textContent = 'No hay reportes en la bandeja.';
        listaOutbox.appendChild(vacio);
        return;
      }

      // Más recientes primero
      registros
        .sort((a, b) => b.fechaCreacion - a.fechaCreacion)
        .forEach((item) => {
          const li = document.createElement('li');

          const titulo = document.createElement('span');
          titulo.className = 'titulo';
          titulo.textContent = item.titulo;

          const estado = document.createElement('span');
          estado.className = `estado ${item.estado}`;
          estado.textContent = item.estado;

          const hora = document.createElement('span');
          hora.className = 'hora';
          hora.textContent = new Date(item.fechaCreacion).toLocaleTimeString('es-MX', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });

          li.appendChild(titulo);
          li.appendChild(estado);
          li.appendChild(hora);
          listaOutbox.appendChild(li);
        });
    })
    .catch((error) => {
      console.error('[UI] Falla al leer IndexedDB:', error);
    });
}

// ---------- CREATE: envío resiliente ----------

function registrarSyncEnSW() {
  // Con SyncManager el reenvío lo hace sw.js aunque se cierre la pestaña
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    return navigator.serviceWorker.ready
      .then((registro) => {
        console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
        return registro.sync.register(ETIQUETA_SYNC);
      })
      .catch((error) => {
        // Si el registro falla, el dato ya está a salvo en IndexedDB
        console.error('[Outbox] No se pudo registrar el sync:', error);
      });
  }
  // Sin SyncManager (Safari/iOS, Firefox) el respaldo es el evento online
  return Promise.resolve();
}

function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: datosFormulario.titulo,
      body: datosFormulario.descripcion
    })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso en vivo: bitácora local como sincronizado
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => registrarSyncEnSW());
    })
    .then(() => {
      return renderizarColaOutbox();
    });
}

// ---------- UPDATE (fallback): solo para navegadores sin SyncManager ----------

function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio);
    })
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    })
    .then(() => {
      // Se repinta aunque algún envío falle: los que sí pasaron ya cambiaron de estado
      return renderizarColaOutbox();
    });
}

window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Degradación elegante: si hay SyncManager, sincroniza sw.js y aquí no se toca nada.
  // Sin este if, app.js y sw.js leerían los mismos pendientes y duplicarían el POST.
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// ---------- Formulario ----------

formulario.addEventListener('submit', (e) => {
  e.preventDefault();

  const datosFormulario = {
    titulo: inputTitulo.value.trim(),
    descripcion: inputDescripcion.value.trim()
  };

  if (!datosFormulario.titulo || !datosFormulario.descripcion) return;

  formulario.reset();
  inputTitulo.focus();

  procesarEnvioReporte(datosFormulario)
    .catch((error) => {
      console.error('[Outbox] Falla al procesar el reporte:', error);
    });
});

// ---------- DELETE: purgar sincronizados ----------

btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Falla al purgar:', error);
    });
});

// ---------- Arranque ----------

actualizarIndicadorRed();

// Esta promesa rescata de IndexedDB los registros guardados en sesiones anteriores
renderizarColaOutbox()
  .then(() => {
    // Sin SyncManager nadie sincroniza con la pestaña cerrada: se intenta al abrir
    if (!('SyncManager' in window) && navigator.onLine) {
      return sincronizarPendientesFallback();
    }
  });
