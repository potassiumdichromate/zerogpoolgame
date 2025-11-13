const UserData = require("../models/UserData");
const crypto = require("crypto");
const { ethers } = require("ethers");

// Generate random referral code
function generateCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

/* -----------------------------------------------------------
   GENERATE REFERRAL CODE (with signature verification)
----------------------------------------------------------- */
exports.generateReferralCode = async (req, res) => {
  try {
    const { walletAddress, signature, nonce } = req.body;

    if (!walletAddress || !signature || !nonce) {
      return res.status(400).json({
        success: false,
        error: "walletAddress, signature and nonce are required",
      });
    }

    const normalized = walletAddress.toLowerCase();

    // The message user signs
    const message = `ZeroGPool Referral Verification
Wallet: ${walletAddress}
Nonce: ${nonce}`;

    // Recover address
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch (err) {
      console.error("Signature verification failed:", err);
      return res.status(401).json({ success: false, error: "Invalid signature" });
    }

    if (recovered.toLowerCase() !== normalized) {
      return res.status(401).json({
        success: false,
        error: "Signature does not match wallet",
      });
    }

    // -----------------------------
    // Find or create user
    // -----------------------------
    let user = await UserData.findOne({ walletAddress: normalized });

    if (!user) {
      user = new UserData({
        walletAddress: normalized,
        referral: {
          referralCode: null,
          referralCount: 0,
          referredBy: null,
        },
      });
    }

    // Already has a referral code → return same
    if (user.referral?.referralCode) {
      return res.json({
        success: true,
        referralCode: user.referral.referralCode,
        referralLink: `https://zerogpool.xyz/?ref=${user.referral.referralCode}`,
      });
    }

    // -----------------------------
    // Generate UNIQUE referral code
    // -----------------------------
    let code = generateCode();
    while (await UserData.findOne({ "referral.referralCode": code })) {
      code = generateCode();
    }

    // Save referral code to this user
    user.referral.referralCode = code;
    await user.save();

    return res.json({
      success: true,
      referralCode: code,
      referralLink: `https://zerogpool.xyz/?ref=${code}`,
    });
  } catch (error) {
    console.error("Referral Generate Error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

/* -----------------------------------------------------------
   CLAIM REFERRAL (when new user signs up)
----------------------------------------------------------- */
exports.claimReferral = async (req, res) => {
  try {
    const { walletAddress, referralCode } = req.body;

    if (!walletAddress || !referralCode) {
      return res.status(400).json({
        success: false,
        error: "walletAddress and referralCode are required",
      });
    }

    const normalizedWallet = walletAddress.toLowerCase();
    const code = referralCode.toUpperCase();

    const inviter = await UserData.findOne({
      "referral.referralCode": code,
    });

    if (!inviter) {
      return res.status(404).json({
        success: false,
        error: "Invalid referral code",
      });
    }

    // Prevent self-referral
    if (inviter.walletAddress === normalizedWallet) {
      return res.status(400).json({
        success: false,
        error: "You cannot use your own referral code",
      });
    }

    // Now check this new user
    let newUser = await UserData.findOne({ walletAddress: normalizedWallet });

    if (!newUser) {
      newUser = new UserData({ walletAddress: normalizedWallet });
    }

    // Already used referral before?
    if (newUser.referral?.referredBy) {
      return res.json({
        success: true,
        message: "Referral already claimed",
        referralCount: inviter.referral.referralCount,
      });
    }

    // Mark this user as referred
    newUser.referral = {
      ...newUser.referral,
      referredBy: code,
    };
    await newUser.save();

    // Increase inviter referral count
    inviter.referral.referralCount += 1;
    await inviter.save();

    return res.json({
      success: true,
      message: "Referral successfully claimed",
      referralCount: inviter.referral.referralCount,
    });
  } catch (error) {
    console.error("Referral Claim Error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
