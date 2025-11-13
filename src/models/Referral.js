const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    unique: true,
    index: true
  },
  referralCode: {
    type: String,
    required: true,
    unique: true
  },
  referralCount: {
    type: Number,
    default: 0
  },
  referredUsers: [
    {
      type: String,
      lowercase: true
    }
  ]
}, { timestamps: true });

module.exports = mongoose.model('Referral', referralSchema);
