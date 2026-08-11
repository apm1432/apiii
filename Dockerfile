FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expose the port Koyeb expects (8000)
EXPOSE 8000

# Start the Node.js server
CMD [ "npm", "start" ]
