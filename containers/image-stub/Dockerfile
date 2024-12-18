FROM node:20-bookworm

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the server will run on
EXPOSE 3000

# Run the app
CMD ["node", "index.mjs"]
