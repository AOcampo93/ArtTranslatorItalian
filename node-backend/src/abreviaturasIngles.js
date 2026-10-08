/**
 * abreviaturasIngles.js
 * Las abreviaturas inglesas cuyo punto NO cierra oración (PLAN.md §17.3).
 *
 * Es la contraparte de `ABREVIATURAS` de `frases.js`, que es la italiana y no se
 * toca (§0.20). Vive en su propio archivo, y no dentro de `idiomas.js`, porque la
 * necesitan dos sitios: el registro, para el troceo de la reunión, y el detector
 * de preguntas inglés, para partir el texto en frases con el MISMO criterio que
 * el troceo. `idiomas.js` importa al detector, así que dejarla allí sería un ciclo.
 *
 * Mismo criterio que la italiana: van sin el punto y en minúscula, y la lista es
 * corta a propósito. Cada entrada de más es una oración que se queda sin cerrar,
 * o sea una burbuja que sale más tarde; equivocarse por ese lado cuesta latencia,
 * y equivocarse por el otro le manda a Marian media oración, que es el fallo que
 * `frases.js` existe para evitar.
 *
 * «e.g.» e «i.e.» NO están, y no hacen falta: el primer punto de cada una va pegado
 * a la letra siguiente, que no cierra oración, y el segundo tiene una sola letra
 * delante («g», «e»), que `puntoCierraOracion` trata como inicial. Lo mismo vale
 * para «a.m.», «p.m.» y «U.S.». `inglesF050.test.js` lo comprueba con «e.g.» e «i.e.».
 *
 * La única de estas que de verdad puede acabar una oración es «etc.» («…the
 * budget, the timeline, etc.»): una oración que acaba así espera al turno
 * siguiente para cerrarse. Se acepta —cuesta una burbuja tardía, no una
 * traducción rota—.
 *
 * `no` NO está, aunque «No.» abrevie «number»: «No.» es una de las respuestas más
 * corrientes de una reunión, y con `no` en la lista «I said no.» no cerraba
 * oración y esperaba al turno siguiente como cola provisional (F050, ronda 2). A
 * cambio, «item No. 5» se parte en «item No.» y «5…», dos burbujas donde cabía
 * una. Cuál de los dos pesa más en una reunión real es `[por medir]` (PLAN.md
 * §17.10); `inglesF050.test.js` fija el lado elegido.
 */

'use strict'

const ABREVIATURAS_INGLES = new Set([
  // Tratamientos y cargos
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  // Empresas
  'inc', 'ltd', 'co', 'corp', 'dept',
  // Texto corriente
  'vs', 'etc', 'approx', 'est', 'fig',
  // Meses. «May» no se abrevia y por eso no está.
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

module.exports = { ABREVIATURAS_INGLES }
