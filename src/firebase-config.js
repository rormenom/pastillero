// 1) Firebase console → Configuración del proyecto → Tus apps → App web → copia aquí el objeto de configuración.
export const firebaseConfig = {
  apiKey: "AIzaSyBuyCxgJAlO_8aFgABxRORzcMaAnCNSb0Y",
  authDomain: "pastillero-f46f6.firebaseapp.com",
  projectId: "pastillero-f46f6",
  storageBucket: "pastillero-f46f6.firebasestorage.app",
  messagingSenderId: "43831700027",
  appId: "1:43831700027:web:16ac28203c0f0299dbca1e"
};

// 2) Solo para avisos push en la versión web:
//    Firebase console → Configuración del proyecto → Cloud Messaging → Certificados push web → "Generar par de claves".
export const VAPID_KEY = "PEGAR_AQUI";
