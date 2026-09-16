"use strict";
/**
 * Genera Manual_Docente_ASIS-CAM.docx (APA 7, lenguaje simple, fotos
 * grandes) con capturas reales del panel del docente de ASIS-CAM PRO
 * corriendo en http://localhost:3000.
 * Uso: node docs/generar_manual_docente.js
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, FONT, A4_PORTRAIT, MARGIN_APA,
  pageFooterAPA, toc, p, bullet, numbered,
  loadLogo, brandedHeader, coverPage, h1, h2, sectionBreak,
  figure, resetFigureCounter,
} = require("./lib/helpers");

const OUT_PATH = path.join(__dirname, "Manual_Docente_ASIS-CAM.docx");

function build(logoBuf) {
  resetFigureCounter();
  const sectionBase = {
    properties: { page: { size: A4_PORTRAIT, margin: MARGIN_APA } },
    headers: { default: brandedHeader(logoBuf, "Manual del Docente") },
    footers: { default: pageFooterAPA() },
  };

  const portada = coverPage(logoBuf, {
    titulo: "ASIS-CAM PRO",
    subtitulo: "Manual del Docente — Guía Fácil y Rápida",
    autor: "Diosmel",
    fecha: "16/09/2026",
  });

  const intro = [
    h1("Antes de Empezar"),
    p(
      "Esta guía te explica, con palabras simples y fotos reales de la pantalla, cómo usar ASIS-CAM PRO para marcar tu entrada y tu salida todos los días. Necesitás:",
      { firstLine: false }
    ),
    bullet("Un celular, tablet o computadora con cámara."),
    bullet("Conexión a internet (o, si no tenés, igual podés fichar: más abajo te explicamos cómo)."),
    bullet("Tu DNI y la contraseña que te dio la administración."),
    sectionBreak(),
  ];

  const ingresar = [
    h1("Paso 1: Ingresar al Sistema"),
    numbered(1, "Abrí el navegador y entrá a la dirección de ASIS-CAM PRO."),
    numbered(2, "Donde dice \"Usuario (DNI)\", escribí tu número de DNI."),
    numbered(3, "Donde dice \"Contraseña\", escribí tu contraseña."),
    numbered(4, "Tocá el botón azul \"Ingresar\"."),
    ...figure("01_login.jpg", "Pantalla de bienvenida de ASIS-CAM PRO, con los campos para escribir tu DNI y tu contraseña.", { width: 380 }),
    p(
      "Consejo: la primera vez que entrás, tu contraseña es la que te dio la administración (por defecto, una contraseña provisoria). Te recomendamos cambiarla apenas puedas, tocando \"Cambiar Contraseña\" en tu panel.",
      { firstLine: false }
    ),
    sectionBreak(),
  ];

  const marcar = [
    h1("Paso 2: Marcar tu Entrada o tu Salida"),
    p(
      "Cuando entrás con tu DNI y tu contraseña, vas a ver tu panel personal: tus datos, tu horario, y a la derecha la cámara para identificarte.",
      { firstLine: false }
    ),
    numbered(1, "Tocá el botón verde \"Identificarme\"."),
    numbered(2, "Mirá de frente a la cámara. Sacate lentes de sol y gorra, y ubicate en un lugar con buena luz."),
    numbered(3, "Esperá unos segundos: el sistema va a comparar tu cara con la que tiene guardada."),
    numbered(4, "Si te reconoce, se va a activar el botón que corresponde a ese momento: \"Entrada\", \"Salida\" o \"Salir antes de tiempo\". Tocá ese botón para completar tu marcación."),
    ...figure("04a_docente_panel_inicial.jpg", "Tu panel personal en ASIS-CAM PRO: a la izquierda tus datos y tu horario, a la derecha la cámara y el botón \"Identificarme\", listo para que marques tu asistencia.", { width: 460 }),
    p(
      "Importante: tenés que tocar \"Identificarme\" antes de CADA marcación (entrada, salida o retiro). El sistema no guarda tu identificación de una vez para otra: siempre te vuelve a pedir que te muestres a la cámara, para que nadie pueda marcar tu asistencia en tu lugar.",
      { firstLine: false }
    ),
    sectionBreak(),
  ];

  const siFalla = [
    h1("¿Qué Hacer si el Sistema No Reconoce tu Rostro?"),
    p(
      "A veces la cámara no detecta tu cara a la primera. Es normal, y tiene solución. Esta es la pantalla real que vas a ver cuando eso pasa:",
      { firstLine: false }
    ),
    ...figure("04_reconocimiento_facial.jpg", "Mensaje real que muestra el sistema cuando no logra detectar un rostro frente a la cámara: \"No se detectó un rostro. Ubicate frente a la cámara con buena iluminación.\"", { width: 460 }),
    h2("Probá esto, en este orden"),
    numbered(1, "Fijate que haya buena luz en tu cara (evitá tener una ventana o una luz fuerte detrás tuyo, porque te oscurece la cara)."),
    numbered(2, "Sacate lentes de sol, gorra o barbijo si los tenés puestos."),
    numbered(3, "Acercate o alejate un poco de la cámara hasta que tu cara se vea completa y de frente."),
    numbered(4, "Tocá \"Identificarme\" de nuevo y esperá unos segundos sin moverte."),
    numbered(5, "Si después de varios intentos el sistema sigue sin reconocerte, avisale a la administración: puede ser necesario volver a sacarte las fotos de referencia."),
    sectionBreak(),
  ];

  const sinInternet = [
    h1("¿Y si no Tengo Conexión a Internet?"),
    p(
      "ASIS-CAM PRO funciona igual sin conexión: el reconocimiento facial no necesita internet para funcionar (ya está preparado en tu dispositivo), así que podés identificarte y marcar tu asistencia igual. Vas a ver un aviso amarillo avisando que tu marcación se guardó en el dispositivo y que se va a subir sola en cuanto vuelva la conexión. No hace falta que hagas nada más: no repitas la marcación."
    ),
    sectionBreak(),
  ];

  const historial = [
    h1("Ver tus Datos y tu Horario"),
    p(
      "En tu panel, en la sección \"Mis Datos\", podés ver en cualquier momento: tu nombre, tu DNI, tu materia, tu teléfono, tu dirección y tu horario de trabajo cargado por la administración. Si algún dato está mal o falta, avisale a la administración para que lo corrija."
    ),
    p(
      "Si necesitás pedir una licencia o un permiso (por ejemplo, por una enfermedad), tenés que comunicarte con la administración: son ellos quienes la cargan en el sistema. Una vez cargada, esos días no se van a contar como falta.",
      { firstLine: false }
    ),
    sectionBreak(),
  ];

  const preguntas = [
    h1("Preguntas Frecuentes"),
    h2("¿Puedo marcar mi asistencia desde mi casa?"),
    p("No. El sistema exige que estés físicamente cerca del establecimiento (dentro de un radio configurado por la administración) para poder fichar por reconocimiento facial, salvo que estés usando una PC autorizada especialmente como \"kiosco\".", { firstLine: false }),
    h2("Marqué \"Salir antes de tiempo\" por error, ¿qué hago?"),
    p("Avisale a la administración. Ellos pueden revisar tu registro y, si corresponde, aclararlo o autorizarlo.", { firstLine: false }),
    h2("¿Qué pasa si me olvido la contraseña?"),
    p("En la pantalla de inicio, tocá \"¿Olvidaste tu contraseña?\" y seguí los pasos, o pedile a la administración que te la restablezca.", { firstLine: false }),
    h2("No tengo cámara disponible ese día, ¿cómo ficho?"),
    p("Avisale a la administración: pueden cargar tu asistencia manualmente ese día como excepción, dejando la aclaración correspondiente.", { firstLine: false }),
  ];

  const children = [
    ...portada,
    ...toc(),
    ...intro,
    ...ingresar,
    ...marcar,
    ...siFalla,
    ...sinInternet,
    ...historial,
    ...preguntas,
  ];

  return new Document({
    creator: "Diosmel",
    title: "Manual del Docente - ASIS-CAM PRO",
    description: "Guía fácil para docentes, con capturas reales del sistema",
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{ ...sectionBase, children }],
  });
}

async function generate() {
  const logoBuf = loadLogo();
  const doc = build(logoBuf);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(OUT_PATH, buffer);
  return OUT_PATH;
}

if (require.main === module) {
  generate()
    .then((outPath) => {
      const { size } = fs.statSync(outPath);
      console.log(`Documento generado: ${outPath} (${(size / 1024).toFixed(1)} KB)`);
    })
    .catch((err) => {
      console.error("Error generando el manual del docente:", err);
      process.exit(1);
    });
}

module.exports = { generate };
