#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# ขั้นที่ 2: Deploy Lucky Spin ขึ้น AWS Lambda ใน region Thailand (ap-southeast-7)
#   ใช้:  bash deploy-th.sh iccfair2026
#   รันซ้ำได้ — ครั้งต่อไปจะอัปเดตโค้ด/รางวัล โดยข้อมูลผู้เล่นยังอยู่
# ─────────────────────────────────────────────────────────────
set -euo pipefail
NAME="${1:?ใส่ชื่องาน เช่น bash deploy-th.sh iccfair2026}"
REGION="${REGION:-ap-southeast-7}"
FN="luckyspin-$NAME"
TABLE="luckyspin-$NAME"
ROLE=luckyspin-lambda-role

[ -f .env ] || { echo "❌ ยังไม่มีไฟล์ .env"; exit 1; }
PW=$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)
[ -n "$PW" ] || { echo "❌ ยังไม่ได้ตั้ง ADMIN_PASSWORD ใน .env"; exit 1; }
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null) \
  || { echo "❌ ยังไม่มีสิทธิ์ $ROLE — ให้ผู้ดูแลรัน bash setup-role-th.sh ก่อน"; exit 1; }

echo "▶ 1/4 แพ็กไฟล์"
rm -f lambda.zip
zip -qr lambda.zip lambda.js server.js store.js event.config.json package.json views public
ls -lh lambda.zip | awk '{print "   ขนาด " $5}'

echo "▶ 2/4 ตาราง DynamoDB: $TABLE"
if ! aws dynamodb describe-table --table-name "$TABLE" --region $REGION >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --region $REGION \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region $REGION
  echo "   สร้างตารางใหม่แล้ว"
else echo "   มีตารางอยู่แล้ว (ข้อมูลเดิมยังอยู่)"; fi

ENV="Variables={TABLE_NAME=$TABLE,ADMIN_PASSWORD=$PW}"
echo "▶ 3/4 ฟังก์ชัน Lambda: $FN"
if ! aws lambda get-function --function-name "$FN" --region $REGION >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN" --region $REGION \
    --runtime nodejs20.x --handler lambda.handler --role "$ROLE_ARN" \
    --zip-file fileb://lambda.zip --memory-size 512 --timeout 15 \
    --environment "$ENV" >/dev/null
  aws lambda wait function-active-v2 --function-name "$FN" --region $REGION
  echo "   สร้างฟังก์ชันแล้ว"
else
  aws lambda update-function-code --function-name "$FN" --region $REGION --zip-file fileb://lambda.zip >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN" --region $REGION
  aws lambda update-function-configuration --function-name "$FN" --region $REGION --environment "$ENV" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN" --region $REGION
  echo "   อัปเดตโค้ดแล้ว"
fi

echo "▶ 4/4 ลิงก์สาธารณะ"
if ! aws lambda get-function-url-config --function-name "$FN" --region $REGION >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FN" --region $REGION --auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FN" --region $REGION --statement-id public-url \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FN" --region $REGION --statement-id public-invoke \
    --action lambda:InvokeFunction --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
fi
URL=$(aws lambda get-function-url-config --function-name "$FN" --region $REGION --query FunctionUrl --output text)

echo
echo "✅ เสร็จแล้ว (region Thailand)"
echo "   หน้าเกม : $URL"
echo "   หลังบ้าน: ${URL}admin"
