FROM node:22-alpine

RUN apk add --no-cache curl imagemagick tesseract-ocr tesseract-ocr-data-eng

WORKDIR /app
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
