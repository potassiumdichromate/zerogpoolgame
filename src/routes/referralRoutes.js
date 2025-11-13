const express = require("express");
const router = express.Router();

const {
  generateReferralCode,
  claimReferral
} = require("../controllers/referralController");

router.post("/generate", generateReferralCode);
router.post("/claim", claimReferral);

module.exports = router;
