#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# ขั้นที่ 1 (ทำครั้งเดียว): สร้างสิทธิ์ให้ Lambda อ่าน/เขียนตาราง luckyspin-* ใน region Thailand
# ⚠️ เป็นการสร้าง IAM role — ให้ผู้ดูแลบัญชี AWS เป็นคนรันเอง
#   ใช้:  bash setup-role-th.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail
ROLE=luckyspin-lambda-role
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "สร้าง role $ROLE แล้ว"
fi

aws iam put-role-policy --role-name "$ROLE" --policy-name luckyspin-access --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:Scan\",\"dynamodb:DescribeTable\"],
     \"Resource\":\"arn:aws:dynamodb:*:${ACCOUNT}:table/luckyspin-*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],
     \"Resource\":\"arn:aws:logs:*:${ACCOUNT}:*\"}
  ]}"
echo "✅ ตั้งสิทธิ์เรียบร้อย — รอ 10 วินาทีแล้วรัน bash deploy-th.sh <ชื่องาน>"
