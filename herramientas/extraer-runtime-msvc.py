#!/usr/bin/env python3
"""
Saca las cuatro DLL del runtime de MSVC del redistribuible OFICIAL de Microsoft
y las deja junto a whisper-server.exe.

Por qué al lado del binario y no instalando el redistribuible
-------------------------------------------------------------
El plan anterior era incluir `vc_redist.x64.exe` en el paquete y pedirle al
cliente que lo ejecutara. Eso falla en las dos prioridades del proyecto:

  · Es un paso manual que el usuario no entiende, y la prioridad número uno es
    "instalar, aceptar permisos y listo".
  · No funcionó: se envió el paquete con el redistribuible dentro, nadie lo
    ejecutó —incluir un instalador no instala nada— y whisper-server.exe murió
    con 0xC0000135 en la máquina virtual.

Microsoft documenta el *despliegue local*: copiar las DLL junto al ejecutable.
No pide permisos de administrador, funciona igual en el zip portable que en el
instalador, y son 925 KB frente a los 25 MB del redistribuible.

Por qué hay un extractor de CAB aquí dentro
-------------------------------------------
`vc_redist.x64.exe` es un bundle de WiX: un PE con cabinets pegados detrás.
En macOS no hay `cabextract` ni `msiextract` de serie, y no vale bajarse las
DLL de un reempaquetado de terceros: esto acaba en el equipo del cliente, así
que la única procedencia aceptable es el propio Microsoft. El formato CAB está
documentado y MSZIP es deflate en crudo encadenando el bloque anterior como
diccionario, de modo que `zlib` de la biblioteca estándar basta.

Los cabinets que este extractor NO sabe leer (LZX) son los paquetes de Windows
Update del CRT universal para Windows 7 y 8. En Windows 10 y 11 el CRT
universal ya viene con el sistema, así que no hacen falta.
"""

import os
import re
import struct
import subprocess
import sys
import tempfile
import zlib

URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

# Nombre dentro del MSI -> nombre real en disco. El sufijo `_amd64` es el
# mangling del instalador, no parte del nombre del archivo.
QUIERO = {
    'msvcp140.dll_amd64':       'msvcp140.dll',
    'vcruntime140.dll_amd64':   'vcruntime140.dll',
    'vcruntime140_1.dll_amd64': 'vcruntime140_1.dll',
    'vcomp140.dll_amd64':       'vcomp140.dll',   # OpenMP: lo piden las ggml-cpu-*
}


# ── Lectura de cabinets ─────────────────────────────────────────────────────

def cabinets(datos):
    """Recorta cada cabinet adosado, localizándolo por firma y tamaño."""
    fuera, i = [], 0
    while True:
        i = datos.find(b'MSCF', i)
        if i < 0:
            return fuera
        try:
            res1, total, res2, coff = struct.unpack_from('<IIII', datos, i + 4)
        except struct.error:
            return fuera
        # Un MSCF real tiene los reservados a cero y un tamaño coherente; así se
        # descartan las apariciones casuales de esos cuatro bytes.
        if res1 == 0 and res2 == 0 and 36 < total <= len(datos) - i and coff < total:
            fuera.append(datos[i:i + total])
            i += total
        else:
            i += 4


def leer_cab(cab):
    """[(nombre, contenido)] de un cabinet MSZIP o sin comprimir."""
    (coff_files,) = struct.unpack_from('<I', cab, 16)
    n_carpetas, n_ficheros, flags = struct.unpack_from('<HHH', cab, 26)

    p, res_carpeta, res_datos = 36, 0, 0
    if flags & 0x0004:                                  # RESERVE_PRESENT
        res_cab, res_carpeta, res_datos = struct.unpack_from('<HBB', cab, p)
        p += 4 + res_cab
    for bandera in (0x0001, 0x0002):                    # PREV / NEXT cabinet
        if flags & bandera:
            for _ in range(2):
                p = cab.index(b'\0', p) + 1

    carpetas = []
    for _ in range(n_carpetas):
        inicio, n_bloques, tipo = struct.unpack_from('<IHH', cab, p)
        carpetas.append((inicio, n_bloques, tipo & 0x000F))
        p += 8 + res_carpeta

    ficheros, p = [], coff_files
    for _ in range(n_ficheros):
        tam, desp = struct.unpack_from('<II', cab, p)
        (i_carpeta,) = struct.unpack_from('<H', cab, p + 8)
        fin = cab.index(b'\0', p + 16)
        ficheros.append((cab[p + 16:fin].decode('cp1252', 'replace'),
                         tam, desp, i_carpeta))
        p = fin + 1

    # Cada carpeta se descomprime entera una vez y luego se recorta por fichero:
    # en MSZIP los bloques dependen del anterior, así que no hay acceso directo.
    crudo = {}
    for idx, (inicio, n_bloques, tipo) in enumerate(carpetas):
        salida, anterior, q = bytearray(), b'', inicio
        for _ in range(n_bloques):
            comprimido, _sin_comprimir = struct.unpack_from('<HH', cab, q + 4)
            q += 8 + res_datos
            bloque, q = cab[q:q + comprimido], q + comprimido
            if tipo == 0:
                salida += bloque
            elif tipo == 1:
                if bloque[:2] != b'CK':
                    raise ValueError('bloque MSZIP sin firma CK')
                d = (zlib.decompressobj(-15, zdict=anterior) if anterior
                     else zlib.decompressobj(-15))
                salida += d.decompress(bloque[2:]) + d.flush()
            else:
                raise NotImplementedError(f'compresión {tipo} (LZX/Quantum)')
            anterior = bytes(salida[-32768:])           # ventana de 32 KB
        crudo[idx] = bytes(salida)

    return [(n, crudo[i][d:d + t]) for n, t, d, i in ficheros if i in crudo]


# ── Verificación de lo extraído ─────────────────────────────────────────────

def arquitectura(d):
    pe = struct.unpack_from('<I', d, 0x3C)[0]
    (m,) = struct.unpack_from('<H', d, pe + 4)
    return {0x8664: 'x64', 0x14C: 'x86', 0xAA64: 'arm64'}.get(m, hex(m))


def esta_firmado(d):
    """¿Tiene bloque de firma Authenticode? (entrada 4 del directorio de datos)"""
    pe = struct.unpack_from('<I', d, 0x3C)[0]
    (magic,) = struct.unpack_from('<H', d, pe + 24)
    dd = pe + 24 + (112 if magic == 0x20B else 96)
    _rva, tam = struct.unpack_from('<II', d, dd + 32)
    return tam > 0


def recurso_version(d):
    """Pares de VS_VERSION_INFO, barriendo las cadenas UTF-16LE del recurso."""
    txt = [m.group().decode('utf-16-le')
           for m in re.finditer(rb'(?:[\x20-\x7e]\x00){4,}', d)]
    campos = {}
    for clave in ('CompanyName', 'FileVersion', 'OriginalFilename'):
        if clave in txt:
            i = txt.index(clave)
            campos[clave] = txt[i + 1] if i + 1 < len(txt) else ''
    return campos


def verificar(nombre, d):
    """Devuelve (ok, detalle). Falla ruidosamente: esto va al equipo del cliente."""
    campos = recurso_version(d)
    problemas = []
    if arquitectura(d) != 'x64':
        problemas.append(f'arquitectura {arquitectura(d)}, se esperaba x64')
    if not esta_firmado(d):
        problemas.append('sin firma Authenticode')
    if campos.get('CompanyName') != 'Microsoft Corporation':
        problemas.append(f'CompanyName={campos.get("CompanyName")!r}')
    if campos.get('OriginalFilename', '').lower() != nombre.lower():
        problemas.append(f'OriginalFilename={campos.get("OriginalFilename")!r}')
    detalle = f'x64 · firmado · v{campos.get("FileVersion", "?")} · Microsoft'
    return (not problemas), ('; '.join(problemas) if problemas else detalle)


# ── Principal ───────────────────────────────────────────────────────────────

def main():
    destino = sys.argv[1] if len(sys.argv) > 1 else 'bin-win'
    os.makedirs(destino, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        redist = os.path.join(tmp, 'vc_redist.x64.exe')
        print(f'Descargando el redistribuible oficial\n  {URL}')
        subprocess.run(['curl', '-sLf', '--max-time', '300', '-o', redist, URL],
                       check=True)
        datos = open(redist, 'rb').read()
        print(f'  {len(datos):,} bytes\n')

        pendientes, sacados = cabinets(datos), {}
        print(f'{len(pendientes)} cabinets adosados; buscando el runtime')
        while pendientes and len(sacados) < len(QUIERO):
            try:
                entradas = leer_cab(pendientes.pop(0))
            except Exception:
                continue        # LZX: paquetes del CRT universal para Win7/8
            for nombre, cuerpo in entradas:
                if cuerpo[:4] == b'MSCF':
                    pendientes.append(cuerpo)
                elif nombre in QUIERO and nombre not in sacados:
                    sacados[nombre] = cuerpo

    fallos = []
    print()
    for mangleado, real in sorted(QUIERO.items()):
        if mangleado not in sacados:
            print(f'  ✗ {real:<22} no está en el redistribuible')
            fallos.append(real)
            continue
        ok, detalle = verificar(real, sacados[mangleado])
        print(f'  {"✓" if ok else "✗"} {real:<22} {len(sacados[mangleado]):>9,} B  {detalle}')
        if ok:
            open(os.path.join(destino, real), 'wb').write(sacados[mangleado])
        else:
            fallos.append(real)

    if fallos:
        print(f'\nNo se escribió nada de: {", ".join(fallos)}')
        return 1
    print(f'\nEscritas en {destino}/')
    return 0


if __name__ == '__main__':
    sys.exit(main())
