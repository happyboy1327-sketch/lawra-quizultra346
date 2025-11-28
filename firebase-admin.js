import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// ESM 환경에서 CommonJS 모듈의 기본 객체를 안전하게 가져옵니다.
const adminApp = adminImport.default || adminImport; 


// 2. 환경 변수 로드 및 키 포맷 수정 로직
const serviceAccountKeyString = process.env.FIREBASE_SERVICE_ACCOUNT_KEY; 
let serviceAccount;

try {
    if (!serviceAccountKeyString) {
        // Vercel 환경에서는 이 오류가 발생하지 않도록 환경 변수를 설정해야 합니다.
        throw new Error("환경 변수 'FIREBASE_SERVICE_ACCOUNT_KEY'가 설정되지 않았습니다.");
    }
    
    // JSON 파싱 및 줄 바꿈 문자 복원
    serviceAccount = JSON.parse(serviceAccountKeyString);
    if (serviceAccount.private_key) {
        // PEM 포맷 오류 방지를 위해 \\n을 \n으로 변환
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    
} catch (error) {
    console.error("❌ Firebase 키 처리 오류. 환경 변수 설정을 확인하세요:", error.message);
    // Vercel에서는 프로세스를 종료하는 대신 오류를 반환합니다.
    throw new Error(`Firebase 초기화 실패: ${error.message}`);
}

// 3. 앱 중복 초기화 방지 로직
const apps = adminApp.getApps();

if (apps.length === 0) {
    // 4. Firebase 초기화
    adminApp.initializeApp({
      credential: adminApp.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin SDK가 초기화되었습니다.");
} else {
    // Vercel은 콜드 스타트 시 매번 초기화할 가능성이 높지만, 안전을 위해 남겨둡니다.
    console.log("⚠️ Firebase Admin SDK는 이미 초기화되어 재사용됩니다.");
}

// 5. 데이터베이스 인스턴스를 가져와서 내보냅니다.
export const db = adminApp.firestore();