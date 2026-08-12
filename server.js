/* ============================================================================
   Jujutsu Kaisen — Blackout · servidor
   ----------------------------------------------------------------------------
   Hace dos cosas por el mismo puerto:

     1. SIRVE EL JUEGO. Entrega index.html, que esta aqui al lado. Con un solo
        despliegue tienes la pagina y el multijugador: la direccion que
        compartes por WhatsApp es la de este servidor.

     2. ES EL RELAY. No simula nada: el combate lo calculan los dos clientes
        con el mismo paso fijo, la misma semilla y las mismas entradas. Aqui
        solo se emparejan jugadores, se les da semilla y mapa, y se copian las
        entradas de uno al otro. Por eso aguanta mucha gente en muy poca
        maquina: por partida son doce enteros por fotograma.

   Protocolo (el que ya habla el cliente, no me lo he inventado):

     ->  hello {name,mmr,cid}      ->  queue {cid,mmr}     ->  cancel
     ->  pick {cid}                ->  input {f,i}         ->  checksum {f,c}
     ->  result {win}
     <-  match {role,seed,map,opp} <-  opp_pick {cid}      <-  input {f,i}
     <-  checksum {f,c}            <-  opponent_left       <-  result

     ->  acc_register|acc_login {u,h}   <- acc_ok {u,token,save,at}
     ->  acc_push {token,save}          <- acc_pushed {at}
     ->  acc_pull {token}               <- acc_save {save,at}
                                        <- acc_err {msg}
   ========================================================================= */
'use strict';
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { WebSocketServer } = require('ws');

const PUERTO  = process.env.PORT || 8787;
const DATOS   = process.env.DATA_FILE || path.join(__dirname, 'datos.json');

/* ============================ 1. LA PAGINA ============================== */
/* El juego es UN SOLO archivo que no pide nada de fuera: ni imagenes, ni
   fuentes, ni scripts. Asi que este servidor no necesita servir una carpeta
   entera, solo ese archivo. Se entrega para cualquier direccion que pidan y
   punto. Ventaja de paso: no hay carpeta que recorrer, asi que no existe la
   posibilidad de que alguien se cuele pidiendo rutas raras. */
const JUEGO = path.join(__dirname, 'index.html');

const servidor = http.createServer((req, res) => {
  if(req.url === '/salud'){ res.writeHead(200); return res.end('ok'); }
  fs.readFile(JUEGO, (err, buf) => {
    if(err){
      res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Falta index.html. Tiene que estar junto a server.js.');
    }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(buf);
  });
});

/* ============================ 2. LAS CUENTAS ============================ */
/* Un JSON y ya. Son cuatro campos por usuario y no merece una base de datos.
   OJO: la contrasena NUNCA llega en claro -- el cliente manda un hash suyo --
   y aqui se vuelve a pasar por scrypt con sal antes de guardarla, asi que ni
   siquiera con el archivo delante se puede entrar en las cuentas.           */
let BD = { usuarios:{} };
try{ BD = JSON.parse(fs.readFileSync(DATOS,'utf8')); }catch(e){}
let guardaPend = null;
function guarda(){
  clearTimeout(guardaPend);
  guardaPend = setTimeout(()=>{
    fs.writeFile(DATOS, JSON.stringify(BD), e=>{ if(e) console.error('no se pudo guardar:', e.message); });
  }, 400);
}
const sal   = ()=> crypto.randomBytes(16).toString('hex');
const cifra = (h,s)=> crypto.scryptSync(String(h), s, 32).toString('hex');
const igual = (a,b)=>{ const A=Buffer.from(a), B=Buffer.from(b);
  return A.length===B.length && crypto.timingSafeEqual(A,B); };
const vale  = u => typeof u==='string' && /^[\w .\-]{2,24}$/.test(u);

/* ============================ 3. EL RELAY =============================== */
const MAPAS = ['shibuya_b5','shibuya_cross','shinjuku','jujutsu_high','kabukicho',
               'kinema','colony','zenin','crater','nakano'];

const cola     = [];        // los que esperan rival
const partidas = new Map(); // id -> {a,b,inicio}
let nPartida   = 0;

const wss = new WebSocketServer({ server: servidor });

function manda(c, o){ try{ if(c && c.readyState===1) c.send(JSON.stringify(o)); }catch(e){} }
const rival = c => c.partida && (c.partida.a===c ? c.partida.b : c.partida.a);

function empareja(){
  /* Emparejar por PC: se ordena la cola y se juntan vecinos. Con dos personas
     esperando es indiferente; con veinte, evita que un novato caiga contra el
     numero uno. */
  cola.sort((x,y)=>(x.perfil.mmr||1000)-(y.perfil.mmr||1000));
  while(cola.length >= 2){
    const a = cola.shift(), b = cola.shift();
    if(a.readyState!==1){ if(b.readyState===1) cola.unshift(b); continue; }
    if(b.readyState!==1){ cola.unshift(a); continue; }

    /* SEMILLA Y MAPA LOS DECIDE EL SERVIDOR, no los clientes. Es lo que hace
       que las dos simulaciones sean identicas fotograma a fotograma. */
    const semilla = (crypto.randomBytes(4).readUInt32BE(0) % 2147483646) + 1;
    const mapa    = MAPAS[Math.floor(Math.random()*MAPAS.length)];
    const p = { id:++nPartida, a, b, inicio:Date.now(), resultado:{} };
    partidas.set(p.id, p);
    a.partida = b.partida = p;
    a.enCola  = b.enCola  = false;

    manda(a, {t:'match', role:0, seed:semilla, map:mapa,
      opp:{ name:b.perfil.name||'Rival', cid:b.perfil.cid||'yuji', mmr:b.perfil.mmr||1000 }});
    manda(b, {t:'match', role:1, seed:semilla, map:mapa,
      opp:{ name:a.perfil.name||'Rival', cid:a.perfil.cid||'yuji', mmr:a.perfil.mmr||1000 }});
    console.log(`[partida ${p.id}] ${a.perfil.name} vs ${b.perfil.name} · ${mapa} · semilla ${semilla}`);
  }
}

function elo(ra, rb, ganoA, k=28){
  const esp = 1/(1+Math.pow(10,(rb-ra)/400));
  return Math.round(ra + k*((ganoA?1:0)-esp));
}

function cierraPartida(p, motivo){
  if(!p || !partidas.has(p.id)) return;
  partidas.delete(p.id);
  for(const c of [p.a,p.b]) if(c) c.partida = null;
  console.log(`[partida ${p.id}] fin (${motivo})`);
}

wss.on('connection', (c, req) => {
  c.perfil = { name:'Anónimo', mmr:1000, cid:'yuji' };
  c.enCola = false; c.partida = null; c.cuenta = null;
  c.ip = (req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  c.vivo = true;
  c.on('pong', ()=>{ c.vivo=true; });

  c.on('message', bruto => {
    /* Nada de confiar en lo que llega: 64 KB de tope y JSON o a la calle. */
    if(bruto.length > 65536) return;
    let m; try{ m = JSON.parse(bruto); }catch(e){ return; }
    if(!m || typeof m.t !== 'string') return;

    switch(m.t){

      /* ---------------------- emparejamiento ---------------------- */
      case 'hello':
        c.perfil = { name:String(m.name||'Anónimo').slice(0,24),
                     mmr:Number(m.mmr)||1000, cid:String(m.cid||'yuji').slice(0,24) };
        break;

      case 'queue':
        if(c.enCola || c.partida) break;
        if(m.cid) c.perfil.cid = String(m.cid).slice(0,24);
        if(m.mmr) c.perfil.mmr = Number(m.mmr)||c.perfil.mmr;
        c.enCola = true; cola.push(c);
        empareja();
        break;

      case 'cancel': {
        const i = cola.indexOf(c);
        if(i >= 0) cola.splice(i,1);
        c.enCola = false;
        break; }

      /* ------------------------ en partida ------------------------ */
      /* Estos tres se copian tal cual al rival. El servidor no los mira ni
         los entiende: es un cable, no un arbitro. */
      case 'pick':
        manda(rival(c), {t:'opp_pick', cid:String(m.cid||'yuji').slice(0,24)});
        break;

      case 'input':
        if(typeof m.f === 'number' && Array.isArray(m.i) && m.i.length <= 8)
          manda(rival(c), {t:'input', f:m.f, i:m.i});
        break;

      case 'checksum':
        if(typeof m.f === 'number') manda(rival(c), {t:'checksum', f:m.f, c:m.c});
        break;

      case 'ping':
        manda(c, {t:'pong', ts:m.ts});
        break;

      case 'result': {
        const p = c.partida; if(!p) break;
        p.resultado[c === p.a ? 'a' : 'b'] = !!m.win;
        /* Se espera a que los dos lo digan y se comprueba que no se
           contradicen: si los dos cantan victoria, algo va mal y no se toca
           la puntuacion de nadie. */
        if(p.resultado.a !== undefined && p.resultado.b !== undefined){
          if(p.resultado.a === p.resultado.b){
            manda(p.a,{t:'result', ok:false, msg:'Resultados contradictorios.'});
            manda(p.b,{t:'result', ok:false, msg:'Resultados contradictorios.'});
          } else {
            const ganoA = p.resultado.a;
            const ra = p.a.perfil.mmr, rb = p.b.perfil.mmr;
            const na = elo(ra, rb, ganoA), nb = elo(rb, ra, !ganoA);
            p.a.perfil.mmr = na; p.b.perfil.mmr = nb;
            manda(p.a, {t:'result', ok:true, win:ganoA,  mmr:na, delta:na-ra});
            manda(p.b, {t:'result', ok:true, win:!ganoA, mmr:nb, delta:nb-rb});
          }
          cierraPartida(p, 'resultado');
        }
        break; }

      /* -------------------------- cuentas ------------------------- */
      case 'acc_register': {
        if(!vale(m.u)) return manda(c,{t:'acc_err', msg:'Nombre no válido (2-24 letras, números, punto o guion).'});
        if(!m.h)       return manda(c,{t:'acc_err', msg:'Falta la credencial.'});
        const k = String(m.u).toLowerCase();
        if(BD.usuarios[k]) return manda(c,{t:'acc_err', msg:'Ese nombre ya está registrado.'});
        const s = sal();
        BD.usuarios[k] = { u:String(m.u), sal:s, clave:cifra(m.h,s),
                           token:crypto.randomBytes(24).toString('hex'),
                           save:null, at:0, creada:Date.now() };
        guarda();
        c.cuenta = k;
        manda(c, {t:'acc_ok', u:BD.usuarios[k].u, token:BD.usuarios[k].token, save:null, at:0});
        console.log('[cuenta] nueva:', m.u);
        break; }

      case 'acc_login': {
        const k = String(m.u||'').toLowerCase();
        const us = BD.usuarios[k];
        if(!us || !m.h) return manda(c,{t:'acc_err', msg:'Usuario o contraseña incorrectos.'});
        if(!igual(cifra(m.h, us.sal), us.clave))
          return manda(c,{t:'acc_err', msg:'Usuario o contraseña incorrectos.'});
        c.cuenta = k;
        manda(c, {t:'acc_ok', u:us.u, token:us.token, save:us.save||null, at:us.at||0});
        break; }

      case 'acc_push': {
        const us = porToken(m.token);
        if(!us) return manda(c,{t:'acc_err', msg:'Sesión caducada. Vuelve a vincular la cuenta.'});
        if(typeof m.save !== 'string' || m.save.length > 400000)
          return manda(c,{t:'acc_err', msg:'El guardado es demasiado grande.'});
        us.save = m.save; us.at = Date.now(); guarda();
        manda(c, {t:'acc_pushed', at:us.at});
        break; }

      case 'acc_pull': {
        const us = porToken(m.token);
        if(!us) return manda(c,{t:'acc_err', msg:'Sesión caducada. Vuelve a vincular la cuenta.'});
        manda(c, {t:'acc_save', save:us.save||null, at:us.at||0});
        break; }
    }
  });

  c.on('close', ()=>{
    const i = cola.indexOf(c); if(i>=0) cola.splice(i,1);
    if(c.partida){
      manda(rival(c), {t:'opponent_left'});
      cierraPartida(c.partida, 'se fue ' + c.perfil.name);
    }
  });
  c.on('error', ()=>{});
});

function porToken(tk){
  if(!tk) return null;
  for(const k in BD.usuarios) if(BD.usuarios[k].token === tk) return BD.usuarios[k];
  return null;
}

/* Latido: sin esto, una conexion que se corta mal (movil que pierde red) se
   queda ahi para siempre ocupando sitio en la cola. */
setInterval(()=>{
  for(const c of wss.clients){
    if(c.vivo === false){ try{ c.terminate(); }catch(e){} continue; }
    c.vivo = false; try{ c.ping(); }catch(e){}
  }
}, 30000);

servidor.listen(PUERTO, ()=>{
  console.log('');
  console.log('  JUJUTSU KAISEN — BLACKOUT · servidor en marcha');
  console.log('  ------------------------------------------------');
  console.log('  juego  ->  http://localhost:' + PUERTO);
  console.log('  relay  ->  ws://localhost:' + PUERTO);
  console.log('  cuentas en ' + DATOS);
  console.log('');
});
