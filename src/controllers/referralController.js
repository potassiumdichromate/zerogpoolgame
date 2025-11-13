const Referral = require("../models/Referral");
const crypto = require("crypto");
const { ethers } = require("ethers");

// Generate random referral code
function generateCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// -----------------------------------------------------------
// GENERATE REFERRAL CODE  (with signature verification)
// -----------------------------------------------------------
exports.generateReferralCode = async (req, res) => {
  try {
    const { walletAddress, signature } = req.body;

    if (!walletAddress || !signature) {
      return res.status(400).json({
        success: false,
        error: "walletAddress and signature are required",
      });
    }

    const normalized = walletAddress.toLowerCase();

    // The message frontend signs:
    const message = `ZeroGPool Referral Verification
Wallet: ${walletAddress}
Nonce: ${req.body.nonce || "MISSING_NONCE"}`;

    // Recover wallet from signature
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch (err) {
      console.error("Signature verify error:", err);
      return res.status(401).json({
        success: false,
        error: "Invalid signature",
      });
    }

    // MUST match connected wallet
    if (recovered.toLowerCase() !== normalized) {
      return res.status(401).json({
        success: false,
        error: "Signature does not match wallet",
      });
    }

    // Check if referral already exists
    let existing = await Referral.findOne({ walletAddress: normalized });

    if (existing) {
      return res.json({
        success: true,
        referralCode: existing.referralCode,
        referralLink: `https://zerogpool.xyz/?ref=${existing.referralCode}`,
      });
    }

    // Create unique code
    let code = generateCode();
    while (await Referral.findOne({ referralCode: code })) {
      code = generateCode();
    }

    const newRef = new Referral({
      walletAddress: normalized,
      referralCode: code,
    });

    await newRef.save();

    return res.json({
      success: true,
      referralCode: code,
      referralLink: `https://zerogpool.xyz/?ref=${code}`,
    });
  } catch (error) {
    console.error("Referral Generate Error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// -----------------------------------------------------------
// CLAIM REFERRAL
// -----------------------------------------------------------
exports.claimReferral = async (req, res) => {
  try {
    const { walletAddress, referralCode } = req.body;

    if (!walletAddress || !referralCode) {
      return res.status(400).json({
        success: false,
        error: "walletAddress and referralCode required",
      });
    }

    const normalizedWallet = walletAddress.toLowerCase();
    const code = referralCode.toUpperCase();

    const ref = await Referral.findOne({ referralCode: code });

    if (!ref) {
      return res.status(404).json({ success: false, error: "Invalid referral code" });
    }

    // Prevent self-referring
    if (ref.walletAddress === normalizedWallet) {
      return res.status(400).json({
        success: false,
        error: "You cannot use your own referral code",
      });
    }

    // Already used referral?
    if (ref.referredUsers.includes(normalizedWallet)) {
      return res.json({
        success: true,
        message: "Referral already counted",
        referralCount: ref.referralCount,
      });
    }

    // Update stats
    ref.referredUsers.push(normalizedWallet);
    ref.referralCount += 1;

    await ref.save();

    return res.json({
      success: true,
      message: "Referral claimed successfully",
      referralCount: ref.referralCount,
    });
  } catch (error) {
    console.error("Referral Claim Error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};
