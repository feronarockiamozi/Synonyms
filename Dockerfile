FROM node:18-slim

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expse the port (Cloud Run sets PORT env var)
EXPOSE 8080

# For Cloud Run, use the start command
CMD [ "node", "api/index.js" ]
