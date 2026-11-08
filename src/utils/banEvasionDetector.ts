// apps/bot/src/utils/banEvasionDetector.ts
import { PrismaClient } from '@prisma/client';
import { decryptFingerprintData, encryptFingerprintData, hashFingerprint } from '../db.js';

const prisma = new PrismaClient();

interface FingerprintData {
  fingerprint: string;
  components: Record<string, any>;
  verificationId?: string; // Persistent browser identifier
  consistency?: number; // Fingerprint consistency score (0-100)
  networkHash?: string;
}

interface BehavioralProfile {
  avgTypingSpeed?: number;
  avgMessageLength?: number;
  commonEmojis: string[];
  commonWords: string[];
  activityPattern: {
    hourly: number[]; // 24 hours
    daily: number[]; // 7 days (0 = Sunday)
  };
}

interface DetectionResult {
  isMatch: boolean;
  linkScore: number; // 0-100 (NOT a probability!)
  breakdown: {
    deviceLink: number; // Strong device fingerprint match
    verificationLink: number; // Persistent verification ID match
    behavioralLink: number; // Behavioral patterns similarity
    accountContext: number; // Join timing, account age, etc.
    consistencyScore: number; // Fingerprint consistency (manipulation detection)
    networkLink: number; // Same server-scoped network token; supporting evidence only
  };
  signals: Array<{
    type: string;
    strength: number; // 0-100
    details: string;
  }>;
  category: 'very_strong' | 'strong' | 'weak' | 'minimal'; // Link category
  bannedUser?: {
    id: string;
    username: string;
    bannedAt: Date;
  };
  linkedUser?: { id: string };
}

export class BanEvasionDetector {
  /**
   * Analyze a new user for potential ban evasion
   */
  static async analyzeUser(
    userId: string,
    guildId: string,
    fingerprintData?: FingerprintData,
    suspectUsername = 'Unknown',
    accountCreatedAt?: Date,
    joinedAt?: Date,
  ): Promise<DetectionResult | null> {
    try {
      // Check if ban evasion detection is enabled for this guild
      const guild = await prisma.guild.findUnique({
        where: { discordId: guildId },
        select: {
          banEvasionEnabled: true,
          banEvasionConfidenceMin: true,
        },
      });

      if (!guild?.banEvasionEnabled) {
        return null;
      }

      // Get all banned users in this guild
      const bannedUsers = await prisma.bannedUser.findMany({
        where: { guildId },
      });

      // Get current user's data
      const userFingerprint = await prisma.userFingerprint.findUnique({
        where: {
          userId_guildId: {
            userId,
            guildId,
          },
        },
      });
      const currentComponents = decryptFingerprintData(userFingerprint?.fingerprintData);
      const suspectFingerprint = fingerprintData?.fingerprint
        ? (fingerprintData.fingerprint.startsWith('v1:') ? fingerprintData.fingerprint : hashFingerprint(guildId, fingerprintData.fingerprint))
        : userFingerprint?.fingerprint;

      const accountContext = {
        joinedAt: joinedAt || new Date(),
        accountAge: accountCreatedAt
          ? Math.max(0, (Date.now() - accountCreatedAt.getTime()) / (1000 * 60 * 60 * 24))
          : Number.POSITIVE_INFINITY,
      };

      let bestMatch: DetectionResult | null = null;
      let highestScore = 0;

      // Compare against each banned user
      for (const bannedUser of bannedUsers) {
        const result = await this.calculateAccountLink(
          {
            fingerprint: suspectFingerprint,
            fingerprintData: fingerprintData?.components || currentComponents,
            verificationId: fingerprintData?.verificationId || currentComponents?.verificationId as string | undefined,
            networkHash: userFingerprint?.networkHash,
            behavioral: userFingerprint ? this.extractBehavioralProfile(userFingerprint) : undefined,
          },
          {
            fingerprint: bannedUser.fingerprint,
            fingerprintData: decryptFingerprintData(bannedUser.fingerprintData),
            networkHash: bannedUser.networkHash,
            behavioral: bannedUser.behavioralData as any,
            bannedAt: bannedUser.createdAt,
          },
          accountContext
        );

        if (result.linkScore > highestScore) {
          highestScore = result.linkScore;
          bestMatch = {
            ...result,
            bannedUser: {
              id: bannedUser.userId,
              username: bannedUser.username,
              bannedAt: bannedUser.createdAt,
            },
          };
        }
      }

      // Only return if link score meets minimum threshold
      if (bestMatch && bestMatch.linkScore >= guild.banEvasionConfidenceMin) {
        // Log the detection
        await prisma.banEvasionDetection.create({
          data: {
            guildId,
            suspectUserId: userId,
            suspectUsername,
            bannedUserId: bestMatch.bannedUser!.id,
            bannedUsername: bestMatch.bannedUser!.username,
            confidenceScore: bestMatch.linkScore,
            fingerprintMatch: bestMatch.breakdown.deviceLink,
            behavioralMatch: bestMatch.breakdown.behavioralLink,
            networkMatch: bestMatch.breakdown.networkLink,
            signals: bestMatch.signals,
            status: 'pending',
          },
        });

        // Increment evasion attempts counter
        await prisma.bannedUser.update({
          where: {
            userId_guildId: {
              userId: bestMatch.bannedUser!.id,
              guildId,
            },
          },
          data: {
            evasionAttempts: {
              increment: 1,
            },
            lastAttemptAt: new Date(),
          },
        });

        return bestMatch;
      }

      // If no banned account matched, check for an exact, previously verified
      // device match within this guild. This is only a review signal: shared
      // devices (for example, family computers) can be legitimate.
      if (suspectFingerprint && suspectFingerprint !== 'pending') {
        const sameDeviceUsers = await prisma.userFingerprint.findMany({
          where: { guildId, userId: { not: userId }, verified: true, fingerprint: suspectFingerprint },
          select: { userId: true, fingerprintData: true },
          take: 10,
        });
        if (sameDeviceUsers.length > 0) {
          const suspectVerificationId = fingerprintData?.verificationId || currentComponents?.verificationId as string | undefined;
          const sameBrowserUser = suspectVerificationId
            ? sameDeviceUsers.find((candidate) => decryptFingerprintData(candidate.fingerprintData)?.verificationId === suspectVerificationId)
            : undefined;
          const linkedUser = sameBrowserUser || sameDeviceUsers[0];
          const verificationLink = sameBrowserUser ? 100 : 0;
          const linkScore = sameBrowserUser ? 92 : 82;
          return {
            isMatch: true,
            linkScore,
            category: sameBrowserUser ? 'strong' : 'weak',
            breakdown: { deviceLink: 100, verificationLink, behavioralLink: 0, accountContext: 0, consistencyScore: 100, networkLink: 0 },
            signals: [{
              type: sameBrowserUser ? 'shared_browser' : 'shared_device',
              strength: linkScore,
              details: sameBrowserUser
                ? 'Same browser verification ID as another verified member in this server'
                : 'Exact device fingerprint also belongs to another verified member in this server; this can be a shared device',
            }],
            linkedUser: { id: linkedUser.userId },
          };
        }
      }

      return null;
    } catch (error) {
      console.error('[BanEvasionDetector] Error analyzing user:', error);
      throw new Error('Ban-evasion verification could not be completed');
    }
  }

  /**
   * Calculate account link score using multi-signal approach
   */
  private static async calculateAccountLink(
    suspect: {
      fingerprint?: string;
      fingerprintData?: any;
      verificationId?: string;
      networkHash?: string | null;
      behavioral?: BehavioralProfile;
    },
    banned: {
      fingerprint?: string | null;
      fingerprintData?: any;
      networkHash?: string | null;
      behavioral?: any;
      bannedAt: Date;
    },
    context: {
      joinedAt: Date;
      accountAge: number; // Discord account age in days
    }
  ): Promise<Omit<DetectionResult, 'bannedUser'>> {
    const signals: Array<{ type: string; strength: number; details: string }> = [];

    // ===== 1. DEVICE LINK (0-100) =====
    // Multiple independent fingerprint signals, not just one hash
    let deviceLink = 0;
    
    if (suspect.fingerprint && banned.fingerprint) {
      // Exact fingerprint match
      if (suspect.fingerprint === banned.fingerprint) {
        deviceLink = 100;
        signals.push({
          type: 'device',
          strength: 100,
          details: 'Exact device fingerprint match',
        });
      } 
      // Component-level comparison for partial match
      else if (suspect.fingerprintData && banned.fingerprintData) {
        const componentMatch = this.compareMultipleFingerprintSignals(
          suspect.fingerprintData,
          banned.fingerprintData
        );
        deviceLink = componentMatch.score;
        
        if (componentMatch.score > 70) {
          signals.push({
            type: 'device',
            strength: componentMatch.score,
            details: `${componentMatch.matchedComponents}/${componentMatch.totalComponents} fingerprint components match`,
          });
        }
      }
    }

    // Network matches are deliberately weak because households, schools,
    // VPNs and carrier NAT can put unrelated members behind one public IP.
    let networkLink = 0;
    if (suspect.networkHash && banned.networkHash && suspect.networkHash === banned.networkHash) {
      networkLink = 70;
      signals.push({
        type: 'network',
        strength: networkLink,
        details: 'Same server-scoped network token (shared networks can cause matches)',
      });
    }

    // ===== 2. VERIFICATION LINK (0-100) =====
    // Persistent browser identifier (strongest signal when available)
    let verificationLink = 0;
    
    if (suspect.verificationId && banned.fingerprintData?.verificationId) {
      if (suspect.verificationId === banned.fingerprintData.verificationId) {
        verificationLink = 100;
        signals.push({
          type: 'verification',
          strength: 100,
          details: 'Same browser verification ID (strongest signal)',
        });
      }
    }

    // ===== 3. BEHAVIORAL LINK (0-100) =====
    // Multiple weak signals combined
    let behavioralLink = 0;
    
    if (suspect.behavioral && banned.behavioral) {
      const behavioralAnalysis = this.analyzeBehavioralPatterns(
        suspect.behavioral,
        banned.behavioral
      );
      behavioralLink = behavioralAnalysis.score;
      
      if (behavioralAnalysis.score > 60) {
        signals.push({
          type: 'behavioral',
          strength: behavioralAnalysis.score,
          details: behavioralAnalysis.matchedPatterns.join(', '),
        });
      }
    }

    // ===== 4. ACCOUNT CONTEXT (0-100) =====
    // Timing, age, and other contextual signals
    let accountContext = 0;
    const contextSignals: string[] = [];
    
    // Join timing (suspicious if joined shortly after ban)
    const daysSinceBan = (context.joinedAt.getTime() - banned.bannedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceBan < 1) {
      accountContext += 40;
      contextSignals.push('joined <24h after ban');
    } else if (daysSinceBan < 7) {
      accountContext += 25;
      contextSignals.push('joined within 1 week of ban');
    } else if (daysSinceBan < 30) {
      accountContext += 10;
      contextSignals.push('joined within 1 month of ban');
    }
    
    // New account (suspicious if account just created)
    if (context.accountAge < 7) {
      accountContext += 30;
      contextSignals.push('account <1 week old');
    } else if (context.accountAge < 30) {
      accountContext += 15;
      contextSignals.push('account <1 month old');
    }
    
    accountContext = Math.min(100, accountContext);
    
    if (accountContext > 50) {
      signals.push({
        type: 'context',
        strength: accountContext,
        details: contextSignals.join(', '),
      });
    }

    // ===== 5. CONSISTENCY SCORE (0-100) =====
    // Detect fingerprint manipulation/spoofing
    let consistencyScore = 100; // Default: assume consistent
    
    if (suspect.fingerprintData) {
      const inconsistencies = this.detectFingerprintInconsistencies(suspect.fingerprintData);
      consistencyScore = Math.max(0, 100 - (inconsistencies.count * 20));
      
      if (inconsistencies.count > 0) {
        signals.push({
          type: 'manipulation',
          strength: inconsistencies.count * 20,
          details: `${inconsistencies.count} fingerprint inconsistencies detected (possible spoofing)`,
        });
      }
    }

    // ===== CALCULATE FINAL LINK SCORE =====
    // Weighted combination (NOT a probability!)
    const weights = {
      verification: 0.35, // 35% - strongest when available
      device: 0.30, // 30% - strong but can change
      network: 0.10, // 10% - supporting signal only
      behavioral: 0.15, // 15% - weak individual signals
      context: 0.05, // 5% - supporting evidence
      consistency: 0.05, // 5% - manipulation penalty
    };

    let linkScore = 
      verificationLink * weights.verification +
      deviceLink * weights.device +
      networkLink * weights.network +
      behavioralLink * weights.behavioral +
      accountContext * weights.context +
      consistencyScore * weights.consistency;

    // Require corroboration for a high-confidence review. A device match by
    // itself is deliberately capped; a repeat browser ID or device+network
    // agreement is stronger, but still sent for human review rather than ban.
    if (verificationLink === 100) linkScore = Math.max(linkScore, 92);
    else if (deviceLink === 100 && networkLink > 0) linkScore = Math.max(linkScore, 87);
    else if (deviceLink === 100) linkScore = Math.min(linkScore, 75);

    // Cap at 100
    linkScore = Math.min(100, Math.round(linkScore * 10) / 10);

    // Determine category
    let category: 'very_strong' | 'strong' | 'weak' | 'minimal';
    if (linkScore >= 95) {
      category = 'very_strong';
    } else if (linkScore >= 85) {
      category = 'strong';
    } else if (linkScore >= 70) {
      category = 'weak';
    } else {
      category = 'minimal';
    }

    return {
      isMatch: linkScore >= 70,
      linkScore,
      breakdown: {
        deviceLink: Math.round(deviceLink * 10) / 10,
        verificationLink: Math.round(verificationLink * 10) / 10,
        behavioralLink: Math.round(behavioralLink * 10) / 10,
        accountContext: Math.round(accountContext * 10) / 10,
        consistencyScore: Math.round(consistencyScore * 10) / 10,
        networkLink: Math.round(networkLink * 10) / 10,
      },
      signals,
      category,
    };
  }

  /**
   * Compare multiple independent fingerprint signals for consistency
   */
  private static compareMultipleFingerprintSignals(
    fp1: any,
    fp2: any
  ): { score: number; matchedComponents: number; totalComponents: number } {
    if (!fp1 || !fp2) return { score: 0, matchedComponents: 0, totalComponents: 0 };

    // Independent signals (not just one hash)
    const signals = [
      { name: 'canvas', weight: 0.15 },
      { name: 'webgl', weight: 0.15 },
      { name: 'audio', weight: 0.10 },
      { name: 'fonts', weight: 0.10 },
      { name: 'screen', weight: 0.10 },
      { name: 'timezone', weight: 0.10 },
      { name: 'language', weight: 0.10 },
      { name: 'platform', weight: 0.10 },
      { name: 'hardwareConcurrency', weight: 0.05 },
      { name: 'deviceMemory', weight: 0.05 },
    ];

    let totalScore = 0;
    let matchedComponents = 0;
    let totalComponents = 0;

    for (const signal of signals) {
      if (fp1[signal.name] !== undefined && fp2[signal.name] !== undefined) {
        totalComponents++;
        const matches = JSON.stringify(fp1[signal.name]) === JSON.stringify(fp2[signal.name]);
        if (matches) {
          matchedComponents++;
          totalScore += signal.weight * 100;
        }
      }
    }

    return {
      score: Math.round(totalScore),
      matchedComponents,
      totalComponents,
    };
  }

  /**
   * Analyze behavioral patterns (multiple weak signals)
   */
  private static analyzeBehavioralPatterns(
    profile1: BehavioralProfile,
    profile2: BehavioralProfile
  ): { score: number; matchedPatterns: string[] } {
    const matchedPatterns: string[] = [];
    let score = 0;
    let signalCount = 0;

    // 1. Activity time patterns (25%)
    if (profile1.activityPattern && profile2.activityPattern) {
      const hourlyCorr = this.pearsonCorrelation(
        profile1.activityPattern.hourly,
        profile2.activityPattern.hourly
      );
      const dailyCorr = this.pearsonCorrelation(
        profile1.activityPattern.daily,
        profile2.activityPattern.daily
      );
      const activityScore = ((hourlyCorr + dailyCorr) / 2 + 1) / 2 * 100;
      
      if (activityScore > 70) {
        score += activityScore * 0.25;
        matchedPatterns.push(`similar activity times (${activityScore.toFixed(0)}%)`);
      }
      signalCount++;
    }

    // 2. Emoji patterns (20%)
    const emojiOverlap = this.arrayOverlap(
      profile1.commonEmojis,
      profile2.commonEmojis
    );
    if (emojiOverlap > 50) {
      score += emojiOverlap * 0.20;
      matchedPatterns.push(`${emojiOverlap.toFixed(0)}% emoji overlap`);
      signalCount++;
    }

    // 3. Message length similarity (15%)
    if (profile1.avgMessageLength && profile2.avgMessageLength) {
      const lengthDiff = Math.abs(profile1.avgMessageLength - profile2.avgMessageLength);
      const lengthSimilarity = Math.max(0, 100 - lengthDiff * 2);
      if (lengthSimilarity > 70) {
        score += lengthSimilarity * 0.15;
        matchedPatterns.push(`similar message length (${lengthSimilarity.toFixed(0)}%)`);
      }
      signalCount++;
    }

    // 4. Typing speed similarity (15%)
    if (profile1.avgTypingSpeed && profile2.avgTypingSpeed) {
      const speedDiff = Math.abs(profile1.avgTypingSpeed - profile2.avgTypingSpeed);
      const speedSimilarity = Math.max(0, 100 - speedDiff * 2);
      if (speedSimilarity > 70) {
        score += speedSimilarity * 0.15;
        matchedPatterns.push(`similar typing speed (${speedSimilarity.toFixed(0)}%)`);
      }
      signalCount++;
    }

    // 5. Word patterns (25%)
    const wordOverlap = this.arrayOverlap(
      profile1.commonWords,
      profile2.commonWords
    );
    if (wordOverlap > 40) {
      score += wordOverlap * 0.25;
      matchedPatterns.push(`${wordOverlap.toFixed(0)}% vocabulary overlap`);
      signalCount++;
    }

    return {
      score: signalCount > 0 ? Math.round(score) : 0,
      matchedPatterns,
    };
  }

  /**
   * Detect fingerprint inconsistencies (manipulation detection)
   * Based on research: manipulated fingerprints often have contradictory attributes
   */
  private static detectFingerprintInconsistencies(
    fpData: any
  ): { count: number; inconsistencies: string[] } {
    const inconsistencies: string[] = [];

    if (!fpData) return { count: 0, inconsistencies: [] };

    // Check 1: GPU vs Canvas consistency
    if (fpData.webgl && fpData.canvas) {
      // If WebGL shows high-end GPU but Canvas is generic, suspicious
      const hasHighEndGPU = fpData.webgl.vendor && 
        (fpData.webgl.vendor.includes('NVIDIA') || fpData.webgl.vendor.includes('AMD'));
      const hasGenericCanvas = fpData.canvas === 'generic' || !fpData.canvas;
      
      if (hasHighEndGPU && hasGenericCanvas) {
        inconsistencies.push('GPU/Canvas mismatch');
      }
    }

    // Check 2: Screen resolution vs deviceMemory
    if (fpData.screen && fpData.deviceMemory) {
      const isHighResolution = (fpData.screen.width * fpData.screen.height) > (1920 * 1080);
      const isLowMemory = fpData.deviceMemory < 4;
      
      if (isHighResolution && isLowMemory) {
        inconsistencies.push('High resolution but low memory');
      }
    }

    // Check 3: Platform vs hardwareConcurrency
    if (fpData.platform && fpData.hardwareConcurrency) {
      // Mobile platforms shouldn't have 8+ cores typically
      const isMobile = fpData.platform.includes('Mobile') || fpData.platform.includes('Android');
      const hasManyCore = fpData.hardwareConcurrency >= 8;
      
      if (isMobile && hasManyCore) {
        inconsistencies.push('Mobile platform with desktop-level CPU');
      }
    }

    // Check 4: Missing expected attributes
    const requiredAttributes = ['canvas', 'webgl', 'screen', 'timezone', 'language'];
    const missingCount = requiredAttributes.filter(attr => !fpData[attr]).length;
    
    if (missingCount > 2) {
      inconsistencies.push(`Missing ${missingCount} expected attributes`);
    }

    return {
      count: inconsistencies.length,
      inconsistencies,
    };
  }

  /**
   * Calculate overlap percentage between two arrays
   */
  private static arrayOverlap(arr1: string[], arr2: string[]): number {
    if (arr1.length === 0 || arr2.length === 0) return 0;

    const set1 = new Set(arr1);
    const set2 = new Set(arr2);
    const intersection = new Set([...set1].filter((x) => set2.has(x)));

    return (intersection.size / Math.max(set1.size, set2.size)) * 100;
  }

  /**
   * Compare activity patterns
   */
  private static compareActivityPatterns(
    pattern1: { hourly: number[]; daily: number[] },
    pattern2: { hourly: number[]; daily: number[] }
  ): number {
    // Calculate correlation between hourly patterns
    const hourlyCorr = this.pearsonCorrelation(
      pattern1.hourly,
      pattern2.hourly
    );

    // Calculate correlation between daily patterns
    const dailyCorr = this.pearsonCorrelation(
      pattern1.daily,
      pattern2.daily
    );

    // Average the two correlations
    const avgCorr = (hourlyCorr + dailyCorr) / 2;

    // Convert correlation (-1 to 1) to percentage (0 to 100)
    return ((avgCorr + 1) / 2) * 100;
  }

  /**
   * Calculate Pearson correlation coefficient
   */
  private static pearsonCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length === 0) return 0;

    const n = x.length;
    const sum_x = x.reduce((a, b) => a + b, 0);
    const sum_y = y.reduce((a, b) => a + b, 0);
    const sum_xy = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sum_x2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sum_y2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sum_xy - sum_x * sum_y;
    const denominator = Math.sqrt(
      (n * sum_x2 - sum_x * sum_x) * (n * sum_y2 - sum_y * sum_y)
    );

    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * Extract behavioral profile from UserFingerprint
   */
  private static extractBehavioralProfile(
    userFingerprint: any
  ): BehavioralProfile {
    return {
      avgTypingSpeed: userFingerprint.avgTypingSpeed,
      avgMessageLength: userFingerprint.avgMessageLength,
      commonEmojis: userFingerprint.commonEmojis || [],
      commonWords: userFingerprint.commonWords || [],
      activityPattern: userFingerprint.activityPattern || {
        hourly: new Array(24).fill(0),
        daily: new Array(7).fill(0),
      },
    };
  }

  /**
   * Update user fingerprint and behavioral data
   */
  static async updateUserFingerprint(
    userId: string,
    guildId: string,
    fingerprintData?: FingerprintData
  ): Promise<void> {
    try {
      await prisma.userFingerprint.upsert({
        where: {
          userId_guildId: {
            userId,
            guildId,
          },
        },
        update: {
          fingerprint: fingerprintData?.fingerprint
            ? (fingerprintData.fingerprint.startsWith('v1:') ? fingerprintData.fingerprint : hashFingerprint(guildId, fingerprintData.fingerprint))
            : undefined,
          fingerprintData: fingerprintData?.components ? encryptFingerprintData(fingerprintData.components) as any : undefined,
          networkHash: fingerprintData?.networkHash,
          lastSeen: new Date(),
          verified: true,
          verifiedAt: new Date(),
        },
        create: {
          userId,
          guildId,
          fingerprint: fingerprintData?.fingerprint
            ? (fingerprintData.fingerprint.startsWith('v1:') ? fingerprintData.fingerprint : hashFingerprint(guildId, fingerprintData.fingerprint))
            : 'pending',
          fingerprintData: fingerprintData?.components ? encryptFingerprintData(fingerprintData.components) as any : undefined,
          networkHash: fingerprintData?.networkHash,
          verified: fingerprintData ? true : false,
          verifiedAt: fingerprintData ? new Date() : null,
          commonEmojis: [],
          commonWords: [],
        },
      });
    } catch (error) {
      console.error('[BanEvasionDetector] Error updating fingerprint:', error);
    }
  }

  /**
   * Track message for behavioral analysis
   */
  static async trackMessage(
    userId: string,
    guildId: string,
    channelId: string,
    message: {
      content: string;
      emojis: string[];
      mentions: number;
      timestamp: Date;
    }
  ): Promise<void> {
    try {
      // Store message analytics
      await prisma.messageAnalytics.create({
        data: {
          userId,
          guildId,
          channelId,
          messageLength: message.content.length,
          wordCount: message.content.split(/\s+/).length,
          emojis: message.emojis,
          mentions: message.mentions,
          timestamp: message.timestamp,
        },
      });

      // Update user fingerprint with behavioral data
      await this.updateBehavioralProfile(userId, guildId);
    } catch (error) {
      console.error('[BanEvasionDetector] Error tracking message:', error);
    }
  }

  /**
   * Update behavioral profile based on message analytics
   */
  private static async updateBehavioralProfile(
    userId: string,
    guildId: string
  ): Promise<void> {
    try {
      // Get recent messages (last 100)
      const messages = await prisma.messageAnalytics.findMany({
        where: { userId, guildId },
        orderBy: { timestamp: 'desc' },
        take: 100,
      });

      if (messages.length < 10) {
        // Not enough data yet
        return;
      }

      // Calculate average message length
      const avgMessageLength =
        messages.reduce((sum, m) => sum + m.messageLength, 0) / messages.length;

      // Extract most common emojis
      const emojiCounts: Record<string, number> = {};
      messages.forEach((m) => {
        m.emojis.forEach((emoji) => {
          emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
        });
      });
      const commonEmojis = Object.entries(emojiCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([emoji]) => emoji);

      // Extract most common words
      const wordCounts: Record<string, number> = {};
      messages.forEach((m) => {
        const words = m.wordCount;
        // Note: We don't store actual words for privacy, just patterns
      });
      const commonWords: string[] = []; // Placeholder

      // Calculate activity pattern
      const hourly = new Array(24).fill(0);
      const daily = new Array(7).fill(0);
      messages.forEach((m) => {
        const hour = m.timestamp.getHours();
        const day = m.timestamp.getDay();
        hourly[hour]++;
        daily[day]++;
      });

      // Update user fingerprint
      await prisma.userFingerprint.update({
        where: {
          userId_guildId: {
            userId,
            guildId,
          },
        },
        data: {
          avgMessageLength,
          commonEmojis,
          commonWords,
          activityPattern: {
            hourly,
            daily,
          },
          messageCount: messages.length,
          lastSeen: new Date(),
        },
      });
    } catch (error) {
      console.error('[BanEvasionDetector] Error updating behavioral profile:', error);
    }
  }

  /**
   * Store banned user data for future comparisons
   */
  static async storeBannedUser(
    userId: string,
    guildId: string,
    username: string,
    bannedBy: string,
    bannedByName: string,
    reason?: string
  ): Promise<void> {
    try {
      // Get user's fingerprint and behavioral data
      const userFingerprint = await prisma.userFingerprint.findUnique({
        where: {
          userId_guildId: {
            userId,
            guildId,
          },
        },
      });

      // Store banned user
      await prisma.bannedUser.upsert({
        where: { userId_guildId: { userId, guildId } },
        update: {
          username,
          fingerprint: userFingerprint?.fingerprint ?? undefined,
          fingerprintData: userFingerprint?.fingerprintData as any ?? undefined,
          networkHash: userFingerprint?.networkHash ?? undefined,
          behavioralData: {
            avgTypingSpeed: userFingerprint?.avgTypingSpeed,
            avgMessageLength: userFingerprint?.avgMessageLength,
            commonEmojis: userFingerprint?.commonEmojis,
            commonWords: userFingerprint?.commonWords,
            activityPattern: userFingerprint?.activityPattern,
          },
          reason,
          bannedBy,
          bannedByName,
        },
        create: {
          userId,
          guildId,
          username,
          fingerprint: userFingerprint?.fingerprint,
          fingerprintData: userFingerprint?.fingerprintData as any,
          networkHash: userFingerprint?.networkHash,
          behavioralData: {
            avgTypingSpeed: userFingerprint?.avgTypingSpeed,
            avgMessageLength: userFingerprint?.avgMessageLength,
            commonEmojis: userFingerprint?.commonEmojis,
            commonWords: userFingerprint?.commonWords,
            activityPattern: userFingerprint?.activityPattern,
          },
          reason,
          bannedBy,
          bannedByName,
        },
      });
    } catch (error) {
      console.error('[BanEvasionDetector] Error storing banned user:', error);
    }
  }
}
