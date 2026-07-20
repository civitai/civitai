// Database abstraction types for cross-app compatibility
// This allows different apps to provide their own database implementations
// while maintaining a consistent interface for the event-engine services

export interface DatabaseUser {
  id: number;
  username: string;
}

export interface DatabaseImage {
  id: number;
  userId: number;
}

export interface DatabaseUserEngagement {
  userId: number;
  targetUserId: number;
  type: 'Follow' | 'Hide' | 'Block' | 'Mute';
}

export interface DatabaseImageEngagement {
  userId: number;
  imageId: number;
  type: 'Hide' | 'Favorite';
}

export interface DatabaseModelEngagement {
  userId: number;
  modelId: number;
  type: 'Hide' | 'Favorite' | 'Notify';
}

export interface DatabaseTag {
  id: number;
  name: string;
}

export interface DatabaseModel {
  id: number;
}

// Database provider interface - apps implement this to provide database access
export interface IDatabaseProvider {
  // User-related queries
  findUserByUsername(username: string): Promise<DatabaseUser | null>;

  // User engagement queries
  findUserEngagements(userId: number, type: 'Follow'): Promise<DatabaseUserEngagement[]>;

  // Image engagement queries
  findImageEngagements(userId: number, type: 'Hide'): Promise<DatabaseImageEngagement[]>;

  // Model engagement queries
  findModelEngagements(userId: number, type: 'Hide'): Promise<DatabaseModelEngagement[]>;

  // Tag queries
  findTagByName(name: string): Promise<DatabaseTag | null>;

  // Model existence checks
  checkModelsExist(modelIds: number[]): Promise<DatabaseModel[]>;
}


// Query result types
export interface UsernameToUserIdResult {
  userId: number | null;
}

export interface HiddenImagesResult {
  imageIds: number[];
}

export interface FollowedUsersResult {
  userIds: number[];
}

export interface HiddenModelsResult {
  modelIds: number[];
}

export interface TagIdResult {
  tagId: number | null;
}

export interface ModelsExistResult {
  existingIds: number[];
}

// Helper class that provides common database operations using the provider
export class DatabaseHelper {
  constructor(private provider: IDatabaseProvider) {
    this.provider = provider;
  }

  async getUserIdFromUsername(username: string): Promise<UsernameToUserIdResult> {
    try {
      const user = await this.provider.findUserByUsername(username);
      return { userId: user?.id ?? null };
    } catch (error) {
      console.error('DatabaseHelper: Error finding user by username:', error);
      return { userId: null };
    }
  }

  async getHiddenImageIds(userId: number): Promise<HiddenImagesResult> {
    try {
      const engagements = await this.provider.findImageEngagements(userId, 'Hide');
      const imageIds = engagements.map(e => e.imageId);
      return { imageIds };
    } catch (error) {
      console.error('DatabaseHelper: Error finding hidden images:', error);
      return { imageIds: [] };
    }
  }

  async getFollowedUserIds(userId: number): Promise<FollowedUsersResult> {
    try {
      const engagements = await this.provider.findUserEngagements(userId, 'Follow');
      const userIds = engagements.map(e => e.targetUserId);
      return { userIds };
    } catch (error) {
      console.error('DatabaseHelper: Error finding followed users:', error);
      return { userIds: [] };
    }
  }

  async getHiddenModelIds(userId: number): Promise<HiddenModelsResult> {
    try {
      const engagements = await this.provider.findModelEngagements(userId, 'Hide');
      const modelIds = engagements.map(e => e.modelId);
      return { modelIds };
    } catch (error) {
      console.error('DatabaseHelper: Error finding hidden models:', error);
      return { modelIds: [] };
    }
  }

  async getTagIdFromName(name: string): Promise<TagIdResult> {
    try {
      const tag = await this.provider.findTagByName(name);
      return { tagId: tag?.id ?? null };
    } catch (error) {
      console.error('DatabaseHelper: Error finding tag by name:', error);
      return { tagId: null };
    }
  }

  async checkModelsExist(modelIds: number[]): Promise<ModelsExistResult> {
    try {
      const models = await this.provider.checkModelsExist(modelIds);
      const existingIds = models.map(m => m.id);
      return { existingIds };
    } catch (error) {
      console.error('DatabaseHelper: Error checking models exist:', error);
      return { existingIds: [] };
    }
  }

}
