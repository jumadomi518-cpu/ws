FROM node:20

# Install MuPDF
RUN apt-get update && apt-get install -y mupdf-tools

# Set working directory
WORKDIR /app

# Copy files
COPY . .

# Install Node dependencies
RUN npm install

# Start server
CMD ["node", "app.js"]
