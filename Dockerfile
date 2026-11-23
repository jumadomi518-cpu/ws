
FROM node:20-bookworm-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libreoffice \
    mupdf-tools \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Start server
CMD ["npm", "start"]

