#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Deploy Lucky Spin ขึ้น AWS Amplify — รันใน AWS CloudShell (region Sydney)
#   ใช้:  bash deploy.sh <ชื่อ-branch> [ชื่อตาราง]
#   เช่น  bash deploy.sh newevent-luckydraw
# ─────────────────────────────────────────────────────────────
set -euo pipefail
APP_ID="${APP_ID:-d2g5ldrtarqy48}"          # แอปเดิม "Sahagroup Fair #30 - Lucky Draw"
REGION="${REGION:-ap-southeast-2}"
BRANCH="${1:?ใส่ชื่อ branch เช่น bash deploy.sh newevent-luckydraw}"
TABLE="${2:-luckyspin-$BRANCH}"

[ -f .env ] || { echo "❌ ยังไม่มีไฟล์ .env (คัดลอกจาก .env.example แล้วตั้ง ADMIN_PASSWORD)"; exit 1; }
grep -q '^ADMIN_PASSWORD=.\+' .env || { echo "❌ ยังไม่ได้ตั้ง ADMIN_PASSWORD ใน .env"; exit 1; }
# บันทึกชื่อตารางลง .env
grep -v '^TABLE_NAME=\|^AWS_REGION=' .env > .env.tmp || true
{ cat .env.tmp; echo "TABLE_NAME=$TABLE"; echo "AWS_REGION=$REGION"; } > .env && rm .env.tmp

echo "▶ 1/5 ติดตั้ง dependency"
npm install --omit=dev --no-audit --no-fund

echo "▶ 2/5 สร้างชุดไฟล์สำหรับ Amplify"
node scripts/build-amplify.js
rm -f deploy.zip && (cd .amplify-hosting && zip -qr ../deploy.zip .)

echo "▶ 3/5 ตาราง DynamoDB: $TABLE"
if ! aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
  echo "   สร้างตารางใหม่แล้ว"
else
  echo "   มีตารางอยู่แล้ว (ใช้ของเดิม)"
fi

echo "▶ 4/5 branch: $BRANCH"
if ! aws amplify get-branch --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" >/dev/null 2>&1; then
  aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" >/dev/null
  echo "   สร้าง branch ใหม่แล้ว"
fi

echo "▶ 5/5 อัปโหลดและ deploy"
read -r JOB_ID URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
  --region "$REGION" --query '[jobId,zipUploadUrl]' --output text)
curl -sS --fail -X PUT -H "Content-Type: application/zip" --upload-file deploy.zip "$URL"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --region "$REGION" >/dev/null

echo
echo "✅ ส่งขึ้นแล้ว (job $JOB_ID) — รอ 1–3 นาที แล้วเปิด:"
echo "   https://$BRANCH.$APP_ID.amplifyapp.com"
echo "   หลังบ้าน: https://$BRANCH.$APP_ID.amplifyapp.com/admin"
echo
echo "⚠️  ครั้งแรก: ต้องให้สิทธิ์แอปเข้าตาราง $TABLE (ดู README หัวข้อ 'สิทธิ์ DynamoDB')"
