import { initializeApp } from "firebase/app";
import { doc, getDoc, getFirestore } from "firebase/firestore";

const connectToDatabase = async () => {
  try {
    const firebaseConfig = {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID,
    };

    const firebase = initializeApp(firebaseConfig);
    const db = getFirestore(firebase);

    const testDocRef = doc(db, "similiar-title/test"); // Adjust the path to a document that should exist for the test
    const testDoc = await getDoc(testDocRef);

    if (testDoc.exists()) {
      console.log("⚡ Firebase initialized\n");
    } else {
      throw new Error("Test connection failed");
    }

    return db;
  } catch (error) {
    throw new Error(`⚠️ Failed to initialize Firebase: ${error} \n`);
  }
};

export default connectToDatabase;
